require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const { exec, execFile, execSync, spawn } = require("child_process");
const execP = promisify(exec);
const execFileP = promisify(execFile);
const net = require("net");
const YouTube = require("youtube-sr").default;

const app = express();
const PORT = 3000;
const API_KEY = process.env.YOUTUBE_API_KEY;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
const YT_API = "https://www.googleapis.com/youtube/v3";
const TOKENS_FILE = path.join(__dirname, ".tokens.json");
const HISTORY_FILE = path.join(__dirname, ".history.json");
const COOKIES_FILE = path.join(__dirname, "cookies.txt");

// Persistent history
let history = [];
let historyMap = new Map(); // url -> entry for O(1) lookup
try {
  if (fs.existsSync(HISTORY_FILE)) {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    // Scrub poisoned titles (proxy filenames written during live playback)
    let scrubbed = 0;
    for (const h of history) {
      if (typeof h.title === "string" && /\.m3u8($|\?)/.test(h.title)) {
        h.title = "";
        scrubbed++;
      }
      historyMap.set(h.url, h);
    }
    if (scrubbed > 0) {
      console.log(`Scrubbed ${scrubbed} poisoned history titles`);
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    }
  }
} catch (err) { console.error("Failed to load history:", err.message); }

const HISTORY_LIMIT = 2000;
let _saveHistoryTimer = null;
let _saveHistoryPending = false;
let _saveHistoryInFlight = false;
function saveHistory() {
  // Debounce writes to avoid blocking event loop on rapid updates
  if (_saveHistoryTimer) return;
  _saveHistoryTimer = setTimeout(() => {
    _saveHistoryTimer = null;
    flushHistory();
  }, 500);
}

function flushHistory() {
  // LRU cap — prune oldest entries beyond the limit
  if (history.length > HISTORY_LIMIT) {
    const dropped = history.splice(HISTORY_LIMIT);
    for (const h of dropped) historyMap.delete(h.url);
  }
  // Serialize writes to avoid overlapping rename races
  if (_saveHistoryInFlight) { _saveHistoryPending = true; return; }
  _saveHistoryInFlight = true;
  const tmpFile = HISTORY_FILE + ".tmp";
  fs.writeFile(tmpFile, JSON.stringify(history, null, 2), (err) => {
    if (err) {
      _saveHistoryInFlight = false;
      if (_saveHistoryPending) { _saveHistoryPending = false; flushHistory(); }
      return;
    }
    fs.rename(tmpFile, HISTORY_FILE, () => {
      _saveHistoryInFlight = false;
      if (_saveHistoryPending) { _saveHistoryPending = false; flushHistory(); }
    });
  });
}

function markWatchedOnYouTube(url) {
  const child = spawn("yt-dlp", [
    "--mark-watched", "--simulate", "--cookies", COOKIES_FILE, "--no-warnings", url,
  ], { stdio: "ignore", detached: false });
  child.unref();
  // Kill if it hangs beyond 15s
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, 15000);
  child.on("exit", () => clearTimeout(timer));
}

function rebuildHistoryMap() {
  historyMap.clear();
  for (const h of history) historyMap.set(h.url, h);
}

async function exportCookies() {
  try {
    await execFileP("yt-dlp", [
      "--cookies-from-browser", "firefox",
      "--cookies", COOKIES_FILE,
      "--simulate", "--no-warnings",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    ], { timeout: 30000 });
    console.log("  Cookies exported to cookies.txt");
    return true;
  } catch (err) {
    console.error("  Failed to export cookies:", err.message);
    return false;
  }
}

function addToHistory(url, title, channel, thumbnail) {
  const existing = historyMap.get(url);
  if (existing) {
    existing.timestamp = Date.now();
    if (title) existing.title = title;
    if (channel) existing.channel = channel;
    if (thumbnail) existing.thumbnail = thumbnail;
    history = [existing, ...history.filter((h) => h.url !== url)];
  } else {
    const entry = { url, title, channel: channel || "", thumbnail: thumbnail || "", timestamp: Date.now(), position: 0, duration: 0 };
    history.unshift(entry);
  }
  history = history.slice(0, 100);
  rebuildHistoryMap();
  saveHistory();
}

function updateHistoryProgress(url, position, duration) {
  const entry = historyMap.get(url);
  if (entry) {
    // Sanity: don't save if position jumps massively from current (cross-video contamination)
    if (entry.duration > 0 && position > entry.duration * 1.1) return;
    entry.position = position;
    entry.duration = duration;
    saveHistory();
  }
}

// Persistent token store
let tokens = null;
try {
  if (fs.existsSync(TOKENS_FILE)) {
    tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
    console.log("Loaded saved tokens");
  }
} catch {}

function saveTokens() {
  if (tokens) {
    fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2), () => {});
  } else {
    fs.unlink(TOKENS_FILE, () => {});
  }
}

app.use(express.json());

// Track file modification time for live reload
let lastModified = Date.now();
fs.watch(path.join(__dirname, "public"), { recursive: true }, () => { lastModified = Date.now(); });
fs.watch(path.join(__dirname, "server.js"), () => { lastModified = Date.now(); });
app.get("/api/version", (_req, res) => res.json({ ts: lastModified }));

app.post("/api/client-log", (req, res) => {
  try {
    const line = `[${new Date().toISOString()}] ${JSON.stringify(req.body || {})}\n`;
    fs.appendFileSync("/tmp/ytctl-client.log", line);
  } catch {}
  res.json({ ok: true });
});

app.get("/api/_debug/sync", (_req, res) => {
  res.json({
    activePlayer,
    nowPlaying,
    currentLiveHlsUrl: currentLiveHlsUrl ? (currentLiveHlsUrl.slice(0, 80) + "...") : null,
    mpvPdtEpochMs,
    mpvPdtISO: mpvPdtEpochMs ? new Date(mpvPdtEpochMs).toISOString() : null,
    mpvPdtRefreshActive: !!mpvPdtRefreshInterval,
    lastManifestFullDuration,
    lastManifestEdgeISO: lastManifestEdgeEpochMs ? new Date(lastManifestEdgeEpochMs).toISOString() : null,
    lastManifestFetchedAt,
    manifestStatsAgeMs: lastManifestFetchedAt ? Date.now() - lastManifestFetchedAt : null,
    subProxyAnchor,
    subProxyAnchorAgeMs: subProxyAnchor ? Date.now() - subProxyAnchor.wallMs : null,
    playbackAnchor,
  });
});

app.get("/api/audio-outputs", async (_req, res) => {
  try {
    const [allOut, curOut] = await Promise.all([
      execP("SwitchAudioSource -a -t output"),
      execP("SwitchAudioSource -c -t output"),
    ]);
    res.json({ outputs: allOut.stdout.trim().split("\n"), current: curOut.stdout.trim() });
  } catch { res.json({ outputs: [], current: "" }); }
});

app.post("/api/audio-output", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Missing name" });
  try {
    await execP(`SwitchAudioSource -s "${name.replace(/"/g, '\\"')}"`);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Switch failed" }); }
});

app.post("/api/toggle-visibility", async (_req, res) => {
  try {
    if (activePlayer === "mpv") {
      phoneActive = !phoneActive;
      if (phoneActive) {
        await execP(`osascript -e 'tell application "System Events" to set visible of process "mpv" to false'`);
      } else {
        await execP(`osascript -e 'tell application "System Events" to set visible of process "mpv" to true'`);
        const { stdout } = await execP("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1");
        const wid = stdout.trim();
        if (wid) {
          await execP(`aerospace focus --window-id ${wid}`);
          if (windowMode === "maximize") await execP(`aerospace fullscreen --no-outer-gaps on --window-id ${wid}`);
          else try { await mpvCommand(["set_property", "ontop", true]); } catch {}
        }
      }
    }
    res.json({ ok: true, visible: !phoneActive });
  } catch { res.status(500).json({ error: "Failed" }); }
});

app.post("/api/lock-mac", async (_req, res) => {
  try {
    await execP(`pmset displaysleepnow`);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Lock failed" }); }
});

app.post("/api/wake-mac", async (_req, res) => {
  try {
    // caffeinate -u -t 1 briefly asserts user activity, which wakes the display
    await execP(`caffeinate -u -t 1`);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Wake failed" }); }
});

// Keep-awake: long-running caffeinate that prevents display + system sleep
let _caffeinateProc = null;
app.post("/api/keep-awake", (req, res) => {
  const enable = req.body?.enable;
  if (enable) {
    if (!_caffeinateProc) {
      // -d: prevent display sleep, -i: prevent idle sleep, -s: prevent system sleep on AC
      _caffeinateProc = spawn("caffeinate", ["-d", "-i", "-s"], { stdio: "ignore" });
      _caffeinateProc.on("exit", () => { _caffeinateProc = null; });
    }
  } else {
    if (_caffeinateProc) { try { _caffeinateProc.kill(); } catch {} _caffeinateProc = null; }
  }
  _macStatusCache.keepAwake = !!_caffeinateProc;
  res.json({ ok: true, keepAwake: _macStatusCache.keepAwake });
});

// Bluetooth device management via blueutil
const BT_BATTERY_BIN = path.join(__dirname, "bin", "bt-battery");
const BT_BATTERY_SRC = path.join(__dirname, "bin", "bt-battery.swift");
if (!fs.existsSync(BT_BATTERY_BIN) && fs.existsSync(BT_BATTERY_SRC)) {
  try {
    execSync(`swiftc ${JSON.stringify(BT_BATTERY_SRC)} -o ${JSON.stringify(BT_BATTERY_BIN)}`, { stdio: "inherit" });
  } catch (e) { console.warn("[bt-battery] compile failed:", e.message); }
}
async function getBluetoothBatteryMap() {
  try {
    const { stdout } = await execP(BT_BATTERY_BIN, { timeout: 3000 });
    const arr = JSON.parse(stdout);
    const map = {};
    for (const d of arr) {
      const addr = (d.address || "").toLowerCase();
      if (!addr) continue;
      const single = d.batteryPercentSingle ?? null;
      const left = d.batteryPercentLeft ?? null;
      const right = d.batteryPercentRight ?? null;
      const cse = d.batteryPercentCase ?? null;
      const combined = d.batteryPercentCombined ?? null;
      let battery = single ?? combined;
      if (battery == null && left != null && right != null) battery = Math.min(left, right);
      else if (battery == null) battery = left ?? right ?? cse;
      map[addr] = { battery, left, right, case: cse };
    }
    return map;
  } catch { return {}; }
}

app.get("/api/bluetooth-devices", async (_req, res) => {
  try {
    const [{ stdout }, batteryMap] = await Promise.all([
      execP("blueutil --paired --format json", { env: { ...process.env, BLUEUTIL_USE_SYSTEM_PROFILER: "1" } }),
      getBluetoothBatteryMap(),
    ]);
    const devices = JSON.parse(stdout).filter(d => d.name && !d.name.includes("Keyboard") && !d.name.includes("Mouse") && !d.name.includes("Trackpad") && !d.name.includes("Keychron") && !d.name.includes("iPhone"));
    res.json({ devices: devices.map(d => {
      const bat = batteryMap[(d.address || "").toLowerCase()] || {};
      return { address: d.address, name: d.name, connected: d.connected, battery: bat.battery ?? null, batteryLeft: bat.left ?? null, batteryRight: bat.right ?? null, batteryCase: bat.case ?? null };
    }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/bluetooth-connect", async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "No address" });
  try {
    const mac = address.replace(/:/g, "-");
    await execP(`BluetoothConnector --connect ${mac}`, { timeout: 15000 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/bluetooth-disconnect", async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "No address" });
  try {
    const mac = address.replace(/:/g, "-");
    await execP(`BluetoothConnector --disconnect ${mac}`, { timeout: 15000 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/focus-cmux", async (_req, res) => {
  try {
    const { stdout: frontOut } = await execP(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`);
    const front = frontOut.trim();
    if (front === "cmux") {
      // Return to mpv — restore previous window state
      phoneActive = false;
      await execP(`osascript -e 'tell application "System Events" to set visible of process "mpv" to true'`);
      const { stdout: widOut } = await execP("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1");
      const mpvWid = widOut.trim();
      if (mpvWid) {
        await execP(`aerospace focus --window-id ${mpvWid}`);
        if (windowMode === "maximize") {
          await execP(`aerospace fullscreen --no-outer-gaps on --window-id ${mpvWid}`);
        } else if (windowMode === "floating") {
          try {
            const screens = getScreenOrigins();
            const { stdout: posOut } = await execP(`osascript -e 'tell application "System Events" to get position of first window of process "mpv"'`);
            const [wx] = posOut.trim().split(", ").map(Number);
            const screen = screens.find(s => wx >= s.x && wx < s.x + s.w) || screens.find(s => s.isMain) || screens[0];
            const w = Math.round(screen.w * 0.38);
            const h = Math.round(w * 9 / 16);
            const posX = screen.x + screen.w - w - 12;
            const posY = screen.y + 38;
            await execP(`osascript -e 'tell application "System Events" to tell process "mpv" to set size of first window to {${w}, ${h}}'`);
            await execP(`osascript -e 'tell application "System Events" to tell process "mpv" to set position of first window to {${posX}, ${posY}}'`);
          } catch {}
          try { mpvCommand(["set_property", "ontop", true]); } catch {}
        }
      }
    } else {
      // Focus cmux — pure AppleScript, no aerospace commands to avoid terminal reflow
      try {
        await execP(`osascript -e 'tell application "System Events" to set frontmost of process "cmux" to true'`);
      } catch {}
    }
    setTimeout(refreshMacStatus, 300); // update cached frontApp
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Focus failed" }); }
});

app.get("/api/mac-status", (_req, res) => {
  res.json(_macStatusCache);
});

// Serve React build if available, fall back to public/
const clientDist = path.join(__dirname, "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { etag: false, lastModified: false }));
}
app.use(express.static(path.join(__dirname, "public"), { etag: false, lastModified: false }));
app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

// ── YouTube API helpers ──

async function ytFetch(endpoint, params, accessToken) {
  const url = new URL(`${YT_API}/${endpoint}`);
  if (!accessToken) url.searchParams.set("key", API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`YouTube API ${res.status}: ${err}`);
  }
  return res.json();
}

function fmtSecs(n) {
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDuration(iso) {
  if (!iso) return "";
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return "";
  const h = parseInt(m[1] || 0);
  const min = parseInt(m[2] || 0);
  const s = parseInt(m[3] || 0);
  if (h > 0) return `${h}:${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${min}:${String(s).padStart(2, "0")}`;
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function timeUntil(dateStr) {
  if (!dateStr) return "";
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `in ${days}d`;
}

function mapVideo(v) {
  const broadcastContent = v.snippet?.liveBroadcastContent;
  const isLive = broadcastContent === "live";
  const isUpcoming = broadcastContent === "upcoming";
  const concurrent = v.liveStreamingDetails?.concurrentViewers;
  const scheduledStart = v.liveStreamingDetails?.scheduledStartTime;
  return {
    id: v.id?.videoId || v.id,
    title: v.snippet.title,
    thumbnail: v.snippet.thumbnails?.high?.url || v.snippet.thumbnails?.medium?.url,
    duration: isLive ? "LIVE" : isUpcoming ? "SOON" : formatDuration(v.contentDetails?.duration),
    channel: v.snippet.channelTitle,
    channelId: v.snippet.channelId,
    views: v.statistics ? parseInt(v.statistics.viewCount || 0) : 0,
    url: `https://www.youtube.com/watch?v=${v.id?.videoId || v.id}`,
    uploadedAt: isUpcoming && scheduledStart ? timeUntil(scheduledStart) : timeAgo(v.snippet.publishedAt),
    live: isLive,
    upcoming: isUpcoming,
    concurrentViewers: concurrent ? parseInt(concurrent) : undefined,
  };
}

async function enrichVideos(ids, accessToken) {
  if (!ids.length) return [];
  // YouTube API max 50 IDs per call — batch, return partial on failure
  const results = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const data = await ytFetch("videos", {
        part: "snippet,contentDetails,statistics,liveStreamingDetails",
        id: batch.join(","),
      }, accessToken);
      results.push(...data.items.map(mapVideo));
    } catch (err) {
      console.error(`enrichVideos batch ${i / 50 + 1} failed:`, err.message);
    }
  }
  return results;
}

async function getAccessToken() {
  if (!tokens) return null;
  // Refresh if expired (with 60s buffer)
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    try {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: tokens.refresh_token,
          grant_type: "refresh_token",
        }),
      });
      const data = await res.json();
      if (data.access_token) {
        tokens.access_token = data.access_token;
        tokens.expires_at = Date.now() + data.expires_in * 1000;
        saveTokens();
      }
    } catch (err) {
      console.error("Token refresh failed:", err.message);
      return null;
    }
  }
  return tokens.access_token;
}

// ── OAuth routes ──

app.get("/oauth/login", (_req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.force-ssl",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get("/oauth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("No code received");

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const data = await tokenRes.json();
    if (data.error) throw new Error(data.error_description || data.error);

    tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    saveTokens();

    // Redirect back to the app
    res.send(`<script>window.location.href = "/";</script>`);
  } catch (err) {
    console.error("OAuth error:", err.message);
    res.status(500).send("Login failed: " + err.message);
  }
});

app.get("/api/auth/status", (_req, res) => {
  res.json({ loggedIn: !!tokens });
});

app.post("/api/auth/logout", (_req, res) => {
  tokens = null;
  saveTokens();
  res.json({ ok: true });
});

// ── API routes ──

// Search uses youtube-sr (free, no quota) by default
// Recent videos from a channel via yt-dlp
app.get("/api/channel-videos", async (req, res) => {
  const { channelId } = req.query;
  if (!channelId) return res.json([]);
  try {
    const { stdout } = await execFileP("yt-dlp", [
      "--cookies", COOKIES_FILE,
      "--flat-playlist", "--dump-json", "--no-warnings",
      "-I", "1:15",
      `https://www.youtube.com/channel/${channelId}/videos`,
    ], { timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
    const videos = stdout.trim().split("\n").filter(Boolean).map(line => {
      const v = JSON.parse(line);
      return {
        id: v.id,
        title: v.title,
        thumbnail: v.thumbnails?.[v.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        duration: v.duration_string || (v.duration ? fmtSecs(v.duration) : ""),
        channel: v.channel || v.uploader,
        url: `https://www.youtube.com/watch?v=${v.id}`,
      };
    });
    // Enrich
    const ids = videos.map(v => v.id).filter(Boolean);
    if (ids.length) {
      try {
        const token = await getAccessToken();
        const enriched = await enrichVideos(ids, token);
        const enrichMap = Object.fromEntries(enriched.map(v => [v.id, v]));
        return res.json(videos.map(v => {
          const e = enrichMap[v.id];
          const h = historyMap.get(v.url);
          const merged = e ? { ...v, channel: e.channel || v.channel, views: e.views || v.views, uploadedAt: e.uploadedAt || "", duration: e.duration || v.duration, channelId: e.channelId } : v;
          if (h?.position > 0 && h?.duration > 0) { merged.savedPosition = h.position; merged.savedDuration = h.duration; }
          return merged;
        }));
      } catch {}
    }
    res.json(videos);
  } catch (err) {
    console.error("Channel videos error:", err.message);
    res.json([]);
  }
});

// Rumble channel scraper
const RUMBLE_CHANNELS = ["nickjfuentes", "TheAlexJonesShow"];

async function scrapeRumbleChannel(channel) {
  // Rumble's channel pages sit behind Cloudflare's JS challenge as of
  // 2026-04. Plain Node fetch / curl / yt-dlp default handlers all
  // return 403 "Just a moment...". The only reliable bypass today is
  // curl_cffi with TLS fingerprint impersonation — see
  // scripts/cloudflare-fetch.py for the target list and rationale.
  const helper = path.join(__dirname, "scripts", "cloudflare-fetch.py");
  const pythonBin = path.join(process.env.HOME || "", "Library/Python/3.14/bin/python3");
  // Prefer the user-install Python that has curl_cffi; fall back to
  // system python3 (user may have installed curl_cffi there instead).
  const bin = fs.existsSync(pythonBin) ? pythonBin : "python3";
  const { stdout: html } = await execFileP(bin, [helper, `https://rumble.com/c/${channel}`], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 20000,
  });
  const blocks = [...html.matchAll(/data-video-id="(\d+)"(.*?)(?=data-video-id|<\/ol>)/gs)];
  const seen = new Set();
  const videos = [];
  for (const [, vid, block] of blocks) {
    if (seen.has(vid)) continue;
    const thumb = block.match(/thumbnail__image[^>]*src="([^"]+)"/);
    const alt = block.match(/alt="([^"]+)"/);
    const isLive = block.includes('thumbnail__thumb--live') || block.includes('status--live');
    const dur = block.match(/videostream__status--duration"\s*>\s*([^<]+)/);
    const href = block.match(/videostream__link link[^>]*href="([^"]+)"/);
    const views = block.match(/data-views="([^"]+)"/);
    const date = block.match(/datetime="([^"]+)"/);
    if (!href || !alt) continue;
    seen.add(vid);
    const url = `https://rumble.com${href[1].replace(/\?.*/, "")}`;
    let uploadedAt = "";
    let _dateMs = 0;
    if (date?.[1]) {
      _dateMs = new Date(date[1]).getTime();
      const diff = Date.now() - _dateMs;
      const mins = Math.floor(diff / 60000);
      const h = Math.floor(mins / 60), d = Math.floor(mins / 1440), mo = Math.floor(mins / 43200);
      if (mins < 60) uploadedAt = `${mins} min ago`;
      else if (h < 24) uploadedAt = `${h} hour${h !== 1 ? 's' : ''} ago`;
      else if (d < 30) uploadedAt = `${d} day${d !== 1 ? 's' : ''} ago`;
      else if (mo < 12) uploadedAt = `${mo} month${mo !== 1 ? 's' : ''} ago`;
      else uploadedAt = `${Math.floor(mo / 12)} year${Math.floor(mo / 12) !== 1 ? 's' : ''} ago`;
    }
    videos.push({
      id: vid,
      title: alt[1],
      thumbnail: thumb?.[1] || "",
      duration: isLive ? "LIVE" : (dur?.[1]?.trim() || ""),
      url,
      channel: channel,
      views: parseInt(views?.[1]) || 0,
      uploadedAt,
      _dateMs,
      platform: "rumble",
    });
  }
  return videos;
}

app.get("/api/rumble", async (req, res) => {
  const channel = req.query.channel;
  try {
    let videos;
    if (channel) {
      videos = await scrapeRumbleChannel(channel);
    } else {
      const results = await Promise.allSettled(RUMBLE_CHANNELS.map(c => scrapeRumbleChannel(c)));
      videos = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
      videos.sort((a, b) => b._dateMs - a._dateMs);
    }
    videos.forEach(v => delete v._dateMs);
    res.json({ videos });
  } catch (err) {
    console.error("Rumble fetch error:", err.message);
    res.json({ videos: [] });
  }
});

// Video preview URL — low quality stream for thumbnail preview.
// YouTube's signed googlevideo URLs expire after ~6h; keep a 3h TTL
// so we don't serve dead links that would make <video> hang mid-load
// and (on iOS) hold a decoder slot forever.
const previewCache = new Map();
const PREVIEW_TTL_MS = 3 * 3600 * 1000;
app.get("/api/preview-url", async (req, res) => {
  const id = req.query.id;
  const isLive = req.query.live === "1";
  if (!id) return res.json({ url: null });
  const cacheKey = isLive ? `live:${id}` : id;
  const cached = previewCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PREVIEW_TTL_MS) {
    return res.json({ url: cached.url, isLive });
  }
  if (cached) previewCache.delete(cacheKey);
  try {
    // VOD: progressive 360p or small DASH video-only. Live: low-bitrate
    // HLS variants (301/300=1080p60, down to 93=360p). iOS Safari plays
    // HLS natively in a <video> tag — perfect for an inline preview.
    const format = isLive ? "93/94/95/96/300/301" : "18/134/133/160";
    const { stdout } = await execFileP("yt-dlp", [
      "--cookies", COOKIES_FILE, "-f", format,
      "--get-url", `https://www.youtube.com/watch?v=${id}`,
    ], { timeout: 10000 });
    const url = stdout.trim();
    if (url) previewCache.set(cacheKey, { url, at: Date.now() });
    // Cap cache at 50 entries
    if (previewCache.size > 50) {
      const first = previewCache.keys().next().value;
      previewCache.delete(first);
    }
    res.json({ url: url || null, isLive });
  } catch {
    res.json({ url: null });
  }
});

app.get("/api/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ videos: [], nextPageToken: null });

  try {

    const results = await YouTube.search(query, { limit: 20, type: "video" });
    res.json({ videos: results.map((v) => ({
      id: v.id,
      title: v.title,
      thumbnail: v.thumbnail?.url,
      duration: v.durationFormatted,
      channel: v.channel?.name,
      channelId: v.channel?.id,
      views: v.views,
      url: v.url,
      uploadedAt: v.uploadedAt || "",
      live: v.live || false,
    })), nextPageToken: null });
  } catch (err) {
    console.error("youtube-sr search failed, trying API:", err.message);
    try {
      const token = await getAccessToken();
      const data = await ytFetch("search", {
        part: "snippet",
        q: query,
        type: "video",
        maxResults: 20,
      }, token);
      const ids = data.items.map((i) => i.id.videoId).filter(Boolean);
      const videos = await enrichVideos(ids, token);
      res.json({ videos, nextPageToken: data.nextPageToken || null });
    } catch (e2) {
      console.error("API search also failed:", e2.message);
      res.status(500).json({ error: "Search failed" });
    }
  }
});

// Channel videos — sorted by recency via yt-dlp
app.get("/api/channel", async (req, res) => {
  const channelId = req.query.id;
  const channelName = req.query.name;
  if (!channelId && !channelName) return res.json({ videos: [] });
  try {
    const url = channelId
      ? `https://www.youtube.com/channel/${channelId}/videos`
      : `https://www.youtube.com/@${channelName.replace(/\s+/g, '')}/videos`;

    // yt-dlp (slow, ~1-3s) and channel metadata (two googleapis calls)
    // run in parallel when we already have channelId. When we only have a
    // name, we have to wait for yt-dlp to resolve the canonical id first,
    // so fall through to sequential for that case.
    const videosPromise = execFileP("yt-dlp", [
      "--cookies", COOKIES_FILE, "--flat-playlist", "--dump-json", "--no-warnings",
      "-I", "1:30", url,
    ], { timeout: 20000, maxBuffer: 10 * 1024 * 1024 });
    const channelInfoPromise = channelId
      ? fetchChannelInfo(channelId).catch(() => null)
      : null;

    const { stdout } = await videosPromise;
    const videos = stdout.trim().split("\n").filter(Boolean).map(line => {
      const v = JSON.parse(line);
      return {
        id: v.id, title: v.title,
        thumbnail: v.thumbnails?.[v.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        duration: v.duration_string || (v.duration ? fmtSecs(v.duration) : ""),
        channel: v.channel || v.uploader,
        channelId: v.channel_id || v.uploader_id || "",
        views: v.view_count || 0,
        url: `https://www.youtube.com/watch?v=${v.id}`,
      };
    });
    const resolvedId = channelId || videos.find(v => v.channelId)?.channelId || null;

    // Enrich with YouTube Data API for dates (independent of channel info)
    const ids = videos.map(v => v.id).filter(Boolean);
    const enrichPromise = ids.length
      ? getAccessToken().then(token => enrichVideos(ids, token)).catch(() => [])
      : Promise.resolve([]);

    // If we didn't already start the channel-info fetch (name-only case),
    // start it now using the id we just resolved from yt-dlp.
    const finalChannelInfoPromise = channelInfoPromise
      || (resolvedId ? fetchChannelInfo(resolvedId).catch(() => null) : Promise.resolve(null));

    const [enriched, channel] = await Promise.all([enrichPromise, finalChannelInfoPromise]);
    const enrichMap = Object.fromEntries(enriched.map(v => [v.id, v]));
    for (const v of videos) {
      const e = enrichMap[v.id];
      if (e) {
        v.duration = e.duration || v.duration;
        v.views = e.views || v.views;
        v.uploadedAt = e.uploadedAt || "";
        v.channelId = e.channelId || v.channelId;
        if (e.live) v.live = true;
      }
    }

    res.json({ channel, videos });
  } catch (err) {
    console.error("Channel fetch failed:", err.message);
    res.json({ videos: [] });
  }
});

// Fetch channel metadata (name, avatar, sub count) + whether the current
// OAuth user is subscribed. Returns null fields on failure but never throws
// a non-200 — this is best-effort augmentation for the channel page header.
async function fetchChannelInfo(channelId) {
  const token = await getAccessToken();
  const info = {
    id: channelId,
    name: "",
    thumbnail: "",
    subscriberCount: null,
    subscribed: false,
    subscriptionId: null, // needed for DELETE when unsubscribing via OAuth
  };

  // channels.list (API key) + subscriptions.list (OAuth) + cookie-based
  // innertube browse all run in parallel. We prefer OAuth's subscriptionId
  // when available (required for DELETE), but fall back to the cookie-
  // derived `subscribed` flag when OAuth isn't set up — that way the
  // correct button state renders even without OAuth. The POST toggle still
  // requires OAuth; we surface a toast if it fails.
  const metaPromise = fetch(
    `${YT_API}/channels?part=snippet,statistics&id=${channelId}&key=${API_KEY}`
  ).then(r => r.json()).catch(err => {
    console.error("channels.list failed:", err.message);
    return null;
  });

  const subPromise = token
    ? fetch(
        `${YT_API}/subscriptions?part=id&mine=true&forChannelId=${channelId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).then(r => r.json()).catch(err => {
        console.error("subscriptions.list failed:", err.message);
        return null;
      })
    : Promise.resolve(null);

  const cookieSubPromise = checkSubscribedViaCookies(channelId).catch(() => null);

  const [metaData, subData, cookieSubbed] = await Promise.all([
    metaPromise, subPromise, cookieSubPromise,
  ]);

  const item = metaData?.items?.[0];
  if (item) {
    info.name = item.snippet?.title || "";
    info.thumbnail =
      item.snippet?.thumbnails?.high?.url ||
      item.snippet?.thumbnails?.default?.url || "";
    const count = item.statistics?.subscriberCount;
    if (count != null) info.subscriberCount = Number(count);
  }

  const sub = subData?.items?.[0];
  if (sub) {
    info.subscribed = true;
    info.subscriptionId = sub.id;
  } else if (cookieSubbed != null) {
    // Fall back to cookie-based state when OAuth didn't report
    info.subscribed = !!cookieSubbed;
  }

  return info;
}

// Cookie-based subscription check via innertube browse. Returns true/false
// if the subscribed field is found in the channel page response, or null
// if the call/parse fails. No OAuth required — works off the same cookies
// that drive the recommended feed.
async function checkSubscribedViaCookies(channelId) {
  const { cookieStr, cookieMap } = parseCookieFile();
  const sapisid = cookieMap["SAPISID"] || cookieMap["__Secure-3PAPISID"];
  if (!sapisid) return null;
  const res = await fetch(
    "https://www.youtube.com/youtubei/v1/browse?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": cookieStr,
        "Authorization": sapisidHash(sapisid, "https://www.youtube.com"),
        "Origin": "https://www.youtube.com",
        "X-Origin": "https://www.youtube.com",
      },
      body: JSON.stringify({
        browseId: channelId,
        context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00" } },
      }),
    }
  );
  if (!res.ok) return null;
  const text = await res.text();

  // YouTube's newer framework keeps live subscription state in
  // `subscribeStateEntity` records. Each record has a base64 key that
  // encodes a protobuf message containing the channel id plus flag bytes,
  // so multiple keys exist per channel (one per button instance). But the
  // `subscribed` bool is consistent across keys for the same channel. We
  // find any record whose decoded key contains this channel's id bytes
  // and read `subscribed` off it.
  //
  // The older `subscribeButtonRenderer` blocks ALSO carry a "subscribed"
  // field, but on modern responses those are "button state templates" —
  // false/true variants meaning "what would the button show in this
  // state," not the current state. Don't trust them as a signal.
  const entityRe = /"subscriptionStateEntity":\{"key":"([^"]+)","subscribed":(true|false)\}/g;
  let m;
  while ((m = entityRe.exec(text)) !== null) {
    const keyB64 = decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/");
    try {
      const decoded = Buffer.from(keyB64, "base64").toString("binary");
      if (decoded.includes(channelId)) return m[2] === "true";
    } catch { /* ignore decode errors */ }
  }
  return null;
}

// Toggle subscription to a channel. Body: { channelId, subscribe: bool }.
// Prefers the cookie-based innertube endpoint (no OAuth needed) — same
// mechanism the YouTube web client uses when you click the button. Falls
// back to the Data API if tokens.json exists.
app.post("/api/subscribe", express.json(), async (req, res) => {
  const { channelId, subscribe } = req.body || {};
  if (!channelId) return res.status(400).json({ error: "channelId required" });

  // Cookie path (primary)
  try {
    const result = await toggleSubscriptionViaCookies(channelId, !!subscribe);
    if (result.ok) {
      // Use YouTube's action-confirmed state when available. Subscription
      // state takes ~5s to propagate through the browse cache, so the next
      // channel fetch may still report the old value — the authoritative
      // signal is the endpoint response itself.
      const subscribed = result.subscribed != null ? result.subscribed : !!subscribe;
      return res.json({ ok: true, subscribed });
    }
    if (result.definitive) {
      return res.status(result.status || 500).json({ error: result.error || "subscribe failed" });
    }
  } catch (err) {
    console.error("cookie subscribe failed, falling back to OAuth:", err.message);
  }

  const token = await getAccessToken();
  if (!token) return res.status(401).json({ error: "No cookies or OAuth available" });

  try {
    if (subscribe) {
      const r = await fetch(`${YT_API}/subscriptions?part=snippet`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          snippet: { resourceId: { kind: "youtube#channel", channelId } },
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        const reason = data.error?.errors?.[0]?.reason;
        if (reason === "subscriptionDuplicate") {
          return res.json({ ok: true, subscribed: true });
        }
        return res.status(r.status).json({ error: data.error?.message || "subscribe failed" });
      }
      return res.json({ ok: true, subscribed: true, subscriptionId: data.id });
    } else {
      const lookup = await fetch(
        `${YT_API}/subscriptions?part=id&mine=true&forChannelId=${channelId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const lookupData = await lookup.json();
      const subId = lookupData.items?.[0]?.id;
      if (!subId) return res.json({ ok: true, subscribed: false });
      const r = await fetch(`${YT_API}/subscriptions?id=${subId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok && r.status !== 204) {
        const data = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: data.error?.message || "unsubscribe failed" });
      }
      return res.json({ ok: true, subscribed: false });
    }
  } catch (err) {
    console.error("/api/subscribe failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cookie-based subscribe/unsubscribe via the innertube endpoints that the
// YouTube web client uses for its Subscribe button clicks. No OAuth scope
// required — just the SAPISID cookie and the signed auth header, which
// we already have working for the browse calls.
//
// Returns:
//   { ok: true }                         — YouTube accepted the change
//   { ok: false, definitive: false }     — fall through to OAuth
//   { ok: false, definitive: true, status, error } — YouTube said no
async function toggleSubscriptionViaCookies(channelId, subscribe) {
  const { cookieStr, cookieMap } = parseCookieFile();
  const sapisid = cookieMap["SAPISID"] || cookieMap["__Secure-3PAPISID"];
  if (!sapisid) return { ok: false, definitive: false };

  const endpoint = subscribe
    ? "https://www.youtube.com/youtubei/v1/subscription/subscribe"
    : "https://www.youtube.com/youtubei/v1/subscription/unsubscribe";

  const body = {
    channelIds: [channelId],
    context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00" } },
  };
  // The subscribe endpoint expects a `params` field that encodes the
  // notification preference. "EgIIAhgA" = no notifications for this channel
  // (user can toggle later). This is the same value the web client sends.
  if (subscribe) body.params = "EgIIAhgA";

  const r = await fetch(
    `${endpoint}?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": cookieStr,
        "Authorization": sapisidHash(sapisid, "https://www.youtube.com"),
        "Origin": "https://www.youtube.com",
        "X-Origin": "https://www.youtube.com",
      },
      body: JSON.stringify(body),
    }
  );

  // 401 from YouTube = auth cookie invalid. Fall through to OAuth rather
  // than reporting a hard failure.
  if (r.status === 401) return { ok: false, definitive: false };

  const text = await r.text();
  if (!r.ok) {
    return { ok: false, definitive: true, status: r.status, error: `YouTube ${r.status}: ${text.slice(0, 200)}` };
  }

  // Parse the `actions` array for an updateSubscribeButtonAction which
  // contains YouTube's confirmed post-toggle state. That value is
  // authoritative even though the browse cache lags by a few seconds.
  try {
    const data = JSON.parse(text);
    if (data.error) {
      return { ok: false, definitive: true, status: 500, error: data.error.message };
    }
    const confirmed = data.actions?.find(a => a.updateSubscribeButtonAction)
      ?.updateSubscribeButtonAction?.subscribed;
    return { ok: true, subscribed: typeof confirmed === "boolean" ? confirmed : undefined };
  } catch {
    return { ok: true };
  }
}

// Extract the "Not interested" feedback token from a video's menu JSON.
// Each video's menu has entries with `imageName` icons; the one with
// imageName=NOT_INTERESTED is followed by a feedbackEndpoint whose token
// we POST to /youtubei/v1/feedback to hide the video from the feed.
function extractNotInterestedToken(json) {
  const m = json.match(/"imageName":"NOT_INTERESTED"[\s\S]{0,600}?"feedbackToken":"([^"]+)"/);
  return m?.[1] || null;
}

// POST /api/not-interested { token } — tells YouTube's algo to downvote
// this video and hide it from future feeds. Uses cookie auth (no OAuth).
app.post("/api/not-interested", express.json(), async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "token required" });
  const { cookieStr, cookieMap } = parseCookieFile();
  const sapisid = cookieMap["SAPISID"] || cookieMap["__Secure-3PAPISID"];
  if (!sapisid) return res.status(401).json({ error: "No SAPISID cookie" });
  try {
    const r = await fetch(
      "https://www.youtube.com/youtubei/v1/feedback?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": cookieStr,
          "Authorization": sapisidHash(sapisid, "https://www.youtube.com"),
          "Origin": "https://www.youtube.com",
          "X-Origin": "https://www.youtube.com",
        },
        body: JSON.stringify({
          feedbackTokens: [token],
          isFeedbackTokenUnencrypted: false,
          shouldMerge: false,
          context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00" } },
        }),
      }
    );
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: `YouTube ${r.status}: ${text.slice(0, 200)}` });
    }
    const data = await r.json();
    // YouTube returns { feedbackResponses: [{ isProcessed: true }] } on success
    const ok = data.feedbackResponses?.[0]?.isProcessed === true;
    res.json({ ok });
  } catch (err) {
    console.error("/api/not-interested failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Home feed — yt-dlp scrapes recommended + subscriptions, deduped
async function getHomeFeed() {
  const parseVideos = (stdout) => stdout.trim().split("\n").filter(Boolean).map((line) => {
    const v = JSON.parse(line);
    return {
      id: v.id,
      title: v.title,
      thumbnail: v.thumbnails?.[v.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
      duration: v.duration_string || (v.duration ? fmtSecs(v.duration) : ""),
      channel: v.channel || v.uploader,
      views: v.view_count || 0,
      url: `https://www.youtube.com/watch?v=${v.id}`,
    };
  });

  const ytdlpArgs = (feed, count) => [
    "--cookies", COOKIES_FILE,
    "--flat-playlist", "--dump-json", "--no-warnings",
    "-I", `1:${count}`,
    `https://www.youtube.com/feed/${feed}`,
  ];
  const opts = { timeout: 25000, maxBuffer: 10 * 1024 * 1024 };

  // Fetch both feeds in parallel
  const [rec, subs] = await Promise.all([
    execFileP("yt-dlp", ytdlpArgs("recommended", 150), opts).then(r => parseVideos(r.stdout)).catch(() => []),
    execFileP("yt-dlp", ytdlpArgs("subscriptions", 100), opts).then(r => parseVideos(r.stdout)).catch(() => []),
  ]);

  // Merge: interleave recommended and subscriptions (deduped)
  const seen = new Set();
  const videos = [];
  let ri = 0, si = 0;
  while (ri < rec.length || si < subs.length) {
    // Alternate: 2 recommended, 1 subscription
    for (let n = 0; n < 2 && ri < rec.length; ri++) {
      if (!seen.has(rec[ri].id)) { seen.add(rec[ri].id); videos.push(rec[ri]); n++; }
    }
    if (si < subs.length) {
      if (!seen.has(subs[si].id)) { seen.add(subs[si].id); videos.push(subs[si]); }
      si++;
    }
  }
  if (!videos.length) throw new Error("empty_feed");
  return videos;
}

// Fetch a single feed type (recommended or subscriptions)
async function getSingleFeed(feedType, count = 50) {
  const parseVideos = (stdout) => stdout.trim().split("\n").filter(Boolean).map((line) => {
    const v = JSON.parse(line);
    return {
      id: v.id, title: v.title,
      thumbnail: v.thumbnails?.[v.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
      duration: v.duration_string || (v.duration ? fmtSecs(v.duration) : ""),
      channel: v.channel || v.uploader, views: v.view_count || 0,
      url: `https://www.youtube.com/watch?v=${v.id}`,
    };
  });
  const { stdout } = await execFileP("yt-dlp", [
    "--cookies", COOKIES_FILE, "--flat-playlist", "--dump-json", "--no-warnings",
    "-I", `1:${count}`, `https://www.youtube.com/feed/${feedType}`,
  ], { timeout: 25000, maxBuffer: 10 * 1024 * 1024 });
  return parseVideos(stdout);
}

// Browse API for recommended feed with continuation support
let recContinuation = null;
async function browseRecommended(continuation = null) {
  const { cookieStr, cookieMap } = parseCookieFile();
  const sapisid = cookieMap["SAPISID"] || cookieMap["__Secure-3PAPISID"];
  if (!sapisid) throw new Error("No SAPISID cookie");
  const headers = {
    "Content-Type": "application/json",
    "Cookie": cookieStr,
    "Authorization": sapisidHash(sapisid, "https://www.youtube.com"),
    "Origin": "https://www.youtube.com",
    "X-Origin": "https://www.youtube.com",
  };
  const body = continuation
    ? { continuation, context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00" } } }
    : { browseId: "FEwhat_to_watch", context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00" } } };
  const res = await fetch("https://www.youtube.com/youtubei/v1/browse?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false", {
    method: "POST", headers, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json();
  const videos = [];
  const shorts = [];
  const filtered = [];
  let nextContinuation = null;
  function extract(obj, depth) {
    if (depth > 30) return;
    if (typeof obj !== "object" || !obj) return;
    if (Array.isArray(obj)) { obj.forEach(i => extract(i, depth + 1)); return; }
    if (obj.continuationItemRenderer) {
      nextContinuation = obj.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || null;
      return;
    }
    // Skip ads — collect into filtered array
    if (obj.adSlotRenderer || obj.promotedVideoRenderer || obj.promotedSparklesWebRenderer || obj.statementBannerRenderer || obj.brandVideoShelfRenderer || obj.brandVideoSingletonRenderer) return;
    if (obj.richItemRenderer?.content?.adSlotRenderer || obj.richItemRenderer?.content?.promotedVideoRenderer || obj.richItemRenderer?.content?.statementBannerRenderer) return;
    if (obj.richItemRenderer?.content?.videoRenderer) {
      const vr = obj.richItemRenderer.content.videoRenderer;
      // Skip promoted ad placements (not creator sponsorship disclosures)
      if (vr.promotedVideoRenderer) return;
      const durText = vr.lengthText?.simpleText || "";
      if (durText) {
        const dp = durText.split(':').map(Number);
        const totalS = dp.length === 3 ? dp[0]*3600+dp[1]*60+dp[2] : dp[0]*60+dp[1];
        if (totalS <= 180) {
          shorts.push({ id: vr.videoId, title: vr.title?.runs?.[0]?.text || "", channel: vr.shortBylineText?.runs?.[0]?.text || "", views: vr.viewCountText?.simpleText || "", thumbnail: vr.thumbnail?.thumbnails?.[vr.thumbnail?.thumbnails?.length-1]?.url || `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`, url: `https://www.youtube.com/shorts/${vr.videoId}`, isShort: true });
          return;
        }
      }
      const bestThumb = vr.thumbnail?.thumbnails?.[vr.thumbnail?.thumbnails?.length-1]?.url || `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`;
      const vrIsLive = !!(vr.badges?.find(b => b.metadataBadgeRenderer?.style === "BADGE_STYLE_TYPE_LIVE_NOW") || vr.thumbnailOverlays?.find(o => o.thumbnailOverlayTimeStatusRenderer?.style === "LIVE"));
      const vrUpcomingText = vr.upcomingEventData?.startTime ? new Date(parseInt(vr.upcomingEventData.startTime) * 1000).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : "";
      const vrIsUpcoming = !!(vr.upcomingEventData || vr.thumbnailOverlays?.find(o => o.thumbnailOverlayTimeStatusRenderer?.style === "UPCOMING"));
      if (!durText && !vrIsLive) console.log(`[browse-vr] no duration for "${(vr.title?.runs?.[0]?.text||'').slice(0,50)}" id=${vr.videoId} upcoming=${vrIsUpcoming} upcomingText=${vrUpcomingText} viewCount=${vr.viewCountText?.simpleText||''}`);
      videos.push({
        id: vr.videoId, title: vr.title?.runs?.[0]?.text || "",
        thumbnail: bestThumb,
        duration: vrIsLive ? "LIVE" : (vrIsUpcoming ? "SOON" : durText),
        channel: vr.shortBylineText?.runs?.[0]?.text || "",
        views: parseInt((vr.viewCountText?.simpleText?.match(/[\d,]+/) || ["0"])[0].replace(/,/g, "")) || 0,
        uploadedAt: vrUpcomingText || (vr.publishedTimeText?.simpleText || ""),
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
        live: vrIsLive, upcoming: vrIsUpcoming,
        notInterestedToken: extractNotInterestedToken(JSON.stringify(vr)),
      });
      return;
    }
    if (obj.richItemRenderer?.content?.lockupViewModel) {
      const lv = obj.richItemRenderer.content.lockupViewModel;
      const id = lv.contentId || "";
      // Skip YouTube ad placements (not creator promo disclosures) — collect into filtered
      const lvStr = JSON.stringify(lv);
      if (/adSlotRenderer|"BADGE_STYLE_TYPE_AD"|"adInfoRenderer"|promotedVideoRenderer|"BADGE_COMMERCE"/i.test(lvStr)) {
        const meta = lv.metadata?.lockupMetadataViewModel;
        const _title = meta?.title?.content || "";
        const _rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
        const _texts = _rows.flatMap(r => r.metadataParts?.map(p => p.text?.content).filter(Boolean) || []);
        const ciSrc = lv.contentImage?.thumbnailViewModel?.image?.sources;
        if (id) filtered.push({ id, title: _title, channel: _texts[0] || "", thumbnail: ciSrc?.[ciSrc.length - 1]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, url: `https://www.youtube.com/watch?v=${id}`, filtered: true });
        return;
      }
      if (id && !id.startsWith("RD")) {
        const meta = lv.metadata?.lockupMetadataViewModel;
        const title = meta?.title?.content || "";
        const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
        const allTexts = rows.flatMap(r => r.metadataParts?.map(p => p.text?.content).filter(Boolean) || []);
        const channel = allTexts[0] || "";
        const viewsText = allTexts.find(t => /views|watching/i.test(t)) || "";
        const agoText = allTexts.find(t => /ago|streamed/i.test(t)) || "";
        const lvJson = JSON.stringify(lv);
        const durAccessibility = lvJson.match(/"label":"((\d+) hours?, )?((\d+) minutes?, )?((\d+) seconds?)"/i);
        let duration = "";
        if (durAccessibility) {
          const h = parseInt(durAccessibility[2]) || 0;
          const m = parseInt(durAccessibility[4]) || 0;
          const s = parseInt(durAccessibility[6]) || 0;
          duration = h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
        }
        const isLive = /watching/i.test(viewsText);
        const scheduledText = allTexts.find(t => /scheduled|premiere/i.test(t)) || "";
        const isUpcoming = /waiting|scheduled|premiere/i.test(viewsText + scheduledText);
        // Parse views: "2.7K views", "5.3K watching", "640,166 views"
        let views = 0;
        const vMatch = viewsText.match(/([\d,.]+)\s*([KMB])?/i);
        if (vMatch) {
          views = parseFloat(vMatch[1].replace(/,/g, ''));
          if (vMatch[2] === 'K') views *= 1000;
          else if (vMatch[2] === 'M') views *= 1000000;
          else if (vMatch[2] === 'B') views *= 1000000000;
          views = Math.round(views);
        }
        // Extract channelId from browse endpoint
        const chanIdMatch = lvJson.match(/"browseId":"(UC[\w-]+)"/);
        const channelId = chanIdMatch?.[1] || "";
        const ciSources = lv.contentImage?.thumbnailViewModel?.image?.sources;
        const thumb = ciSources?.[ciSources.length - 1]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        const uploadedAt = agoText || scheduledText || "";
        // Detect shorts: duration under 61s and not live/upcoming
        let totalSecs = 0;
        if (durAccessibility) {
          totalSecs = (parseInt(durAccessibility[2]) || 0) * 3600 + (parseInt(durAccessibility[4]) || 0) * 60 + (parseInt(durAccessibility[6]) || 0);
        }
        if (totalSecs > 0 && totalSecs <= 180 && !isLive && !isUpcoming) {
          shorts.push({ id, title, channel, views: viewsText, thumbnail: thumb, url: `https://www.youtube.com/shorts/${id}`, isShort: true });
        } else {
          videos.push({ id, title, channel, channelId, thumbnail: thumb, duration: isLive ? "LIVE" : (isUpcoming ? "SOON" : duration), views, uploadedAt, url: `https://www.youtube.com/watch?v=${id}`, live: isLive, upcoming: isUpcoming, concurrentViewers: isLive ? views : undefined, notInterestedToken: extractNotInterestedToken(lvJson) });
        }
      }
      return;
    }
    if (obj.shortsLockupViewModel) {
      const sv = obj.shortsLockupViewModel;
      const id = sv.onNavigateCommand?.innertubeCommand?.reelWatchEndpoint?.videoId
        || sv.entityId?.replace('shorts-shelf-item-', '') || "";
      if (id) {
        shorts.push({
          id, title: sv.overlayMetadata?.primaryText?.content || "",
          views: sv.overlayMetadata?.secondaryText?.content || "",
          thumbnail: sv.thumbnail?.sources?.[sv.thumbnail?.sources?.length - 1]?.url || `https://i.ytimg.com/vi/${id}/hq720.jpg`,
          url: `https://www.youtube.com/shorts/${id}`,
          isShort: true,
        });
      }
      return;
    }
    if (obj.videoRenderer) {
      const vr = obj.videoRenderer;
      const durText = vr.lengthText?.simpleText || "";
      // Filter shorts (≤60s) into shorts array
      if (durText) {
        const dp = durText.split(':').map(Number);
        const totalS = dp.length === 3 ? dp[0]*3600+dp[1]*60+dp[2] : dp[0]*60+dp[1];
        if (totalS <= 180) {
          shorts.push({ id: vr.videoId, title: vr.title?.runs?.[0]?.text || "", channel: vr.shortBylineText?.runs?.[0]?.text || "", views: vr.viewCountText?.simpleText || "", thumbnail: `https://i.ytimg.com/vi/${vr.videoId}/hq720.jpg`, url: `https://www.youtube.com/shorts/${vr.videoId}`, isShort: true });
          return;
        }
      }
      videos.push({
        id: vr.videoId, title: vr.title?.runs?.[0]?.text || "",
        thumbnail: `https://i.ytimg.com/vi/${vr.videoId}/hq720.jpg`,
        duration: durText,
        channel: vr.shortBylineText?.runs?.[0]?.text || "",
        views: parseInt((vr.viewCountText?.simpleText?.match(/[\d,]+/) || ["0"])[0].replace(/,/g, "")) || 0,
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
      });
      return;
    }
    Object.values(obj).forEach(v => extract(v, depth + 1));
  }
  extract(data, 0);
  recContinuation = nextContinuation;
  return { videos, shorts, filtered, hasMore: !!nextContinuation };
}

// Cache raw home feed so pagination doesn't re-fetch
let homeFeedCache = [];
let homeFeedType = null;
let recShortsCache = [];
let recFilteredCache = [];

function getFinishedIds() {
  const ids = new Set();
  for (const h of historyMap.values()) {
    if (h.duration > 0 && h.position / h.duration >= 0.95) {
      const m = h.url?.match(/v=([\w-]+)/);
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}
function filterFinished(videos, finished) {
  return videos.filter(v => {
    const id = v.id || v.url?.match(/v=([\w-]+)/)?.[1];
    return !id || !finished.has(id);
  });
}

app.get("/api/home", async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const feed = req.query.feed || 'home'; // 'home' (mixed), 'recommended', 'subscriptions'
  const pageSize = 24;
  try {
    // Recommended uses browse API with continuation for infinite scroll, falls back to yt-dlp
    if (feed === 'recommended') {
      // Always fetch fresh — browse API for initial, continuation for more
      const finished = getFinishedIds();
      if (page === 0 || homeFeedType !== feed) {
        recContinuation = null;
        try {
          const result = await browseRecommended();
          if (result.videos.length < 5) throw new Error("too few results");
          homeFeedCache = filterFinished(result.videos, finished);
          recShortsCache = result.shorts || [];
          recFilteredCache = result.filtered || [];
        } catch {
          homeFeedCache = filterFinished(await getSingleFeed('recommended', 150), finished);
          recContinuation = null;
        }
        homeFeedType = feed;
      }
      // Fetch continuations until we have enough videos for this page (post-filter)
      while (recContinuation && (page + 1) * pageSize > homeFeedCache.length) {
        try {
          const result = await browseRecommended(recContinuation);
          if (!result.videos.length) break;
          homeFeedCache = [...homeFeedCache, ...filterFinished(result.videos, finished)];
          if (result.filtered?.length) recFilteredCache = [...recFilteredCache, ...result.filtered];
        } catch { break; }
      }
      const slice = homeFeedCache.slice(page * pageSize, (page + 1) * pageSize);
      const hasMore = (page + 1) * pageSize < homeFeedCache.length || !!recContinuation;
      // Return immediately with browse data, enrich in background
      const videos = slice.map(v => {
        const h = historyMap.get(v.url);
        if (h?.position > 0 && h?.duration > 0) { v.savedPosition = h.position; v.savedDuration = h.duration; }
        return v;
      });
      const resp = { videos, hasMore, nextPageToken: hasMore ? String(page + 1) : null };
      if (page === 0 && recShortsCache.length) resp.shorts = recShortsCache;
      if (page === 0 && recFilteredCache.length) resp.filtered = recFilteredCache;
      res.json(resp);
      // Enrich cache in background for next load
      const ids = slice.map(v => v.id).filter(Boolean);
      if (ids.length) {
        getAccessToken().then(token => enrichVideos(ids, token)).then(enriched => {
          const enrichMap = Object.fromEntries(enriched.map(v => [v.id, v]));
          for (const v of homeFeedCache) {
            const e = enrichMap[v.id];
            if (e) { v.channel = e.channel || v.channel; v.channelId = e.channelId; v.views = e.views || v.views; v.uploadedAt = e.uploadedAt || ""; v.duration = e.duration || v.duration; v.live = e.live || false; }
          }
        }).catch(() => {});
      }
      return;
    }

    // Other feeds use yt-dlp
    if (page === 0 || homeFeedType !== feed) {
      homeFeedType = feed;
      if (feed === 'subscriptions') {
        homeFeedCache = await getSingleFeed('subscriptions', 100);
      } else {
        homeFeedCache = await getHomeFeed();
      }
    }
    const slice = homeFeedCache.slice(page * pageSize, (page + 1) * pageSize);
    const hasMore = (page + 1) * pageSize < homeFeedCache.length;

    // Enrich this page's videos
    const ids = slice.map(v => v.id).filter(Boolean);
    if (ids.length) {
      try {
        const token = await getAccessToken();
        const enriched = await enrichVideos(ids, token);
        const enrichMap = Object.fromEntries(enriched.map(v => [v.id, v]));
        return res.json({ videos: slice.map(v => {
          const e = enrichMap[v.id];
          const h = historyMap.get(v.url);
          const merged = e ? { ...v, channel: e.channel || v.channel, channelId: e.channelId, views: e.views || v.views, uploadedAt: e.uploadedAt || "", duration: e.duration || v.duration, live: e.live || false, concurrentViewers: e.concurrentViewers } : v;
          if (h?.position > 0 && h?.duration > 0) { merged.savedPosition = h.position; merged.savedDuration = h.duration; }
          return merged;
        }), hasMore, nextPageToken: hasMore ? String(page + 1) : null });
      } catch {}
    }
    res.json({ videos: slice.map(v => {
      const h = historyMap.get(v.url);
      if (h?.position > 0 && h?.duration > 0) { v.savedPosition = h.position; v.savedDuration = h.duration; }
      return v;
    }), hasMore, nextPageToken: hasMore ? String(page + 1) : null });
  } catch (err) {
    console.error("Home feed failed:", err.message);
    res.json([]);
  }
});

// Live streams — pull live items from home feed (subs), then youtube-sr for general
async function fetchLiveStreams() {

  // Run home feed scrape + youtube-sr in parallel
  const [homeVideos, srResults] = await Promise.all([
    getHomeFeed().catch(() => []),
    YouTube.search("live", { limit: 20, type: "video" }).catch(() => []),
  ]);

  const seen = new Set();
  const subLive = [];
  const generalLive = [];

  // Live items from home feed = subscribed channels that are live (duration is empty)
  const homeLiveIds = homeVideos.filter(v => !v.duration).map(v => v.id);
  if (homeLiveIds.length) {
    try {
      const token = await getAccessToken();
      const enriched = await enrichVideos(homeLiveIds, token);
      for (const v of enriched) {
        seen.add(v.id);
        subLive.push({ ...v, subscribed: true });
      }
    } catch {}
  }

  // General live from youtube-sr
  for (const v of srResults) {
    if (v.duration === 0 && !seen.has(v.id)) {
      seen.add(v.id);
      generalLive.push({
        id: v.id,
        title: v.title,
        thumbnail: v.thumbnail?.url,
        duration: "LIVE",
        channel: v.channel?.name,
        views: v.views,
        url: v.url,
        uploadedAt: "",
        live: true,
      });
    }
  }
  return [...subLive, ...generalLive];
}

app.get("/api/live", async (_req, res) => {
  try {
    const [ytData, rumbleResults] = await Promise.allSettled([
      fetchLiveStreams(),
      Promise.allSettled(RUMBLE_CHANNELS.map(c => scrapeRumbleChannel(c))),
    ]);
    const ytLive = ytData.status === "fulfilled" ? ytData.value : [];
    const rumbleLive = (rumbleResults.status === "fulfilled" ? rumbleResults.value : [])
      .flatMap(r => r.status === "fulfilled" ? r.value : [])
      .filter(v => v.duration === "LIVE");
    res.json([...rumbleLive, ...ytLive]);
  } catch (err) {
    console.error("Live search failed:", err.message);
    res.json([]);
  }
});

// Trending — youtube-sr first (free), API fallback
app.get("/api/trending", async (_req, res) => {
  try {

    const results = await YouTube.search("popular videos today", { limit: 20, type: "video" });
    res.json(results.map((v) => ({
      id: v.id,
      title: v.title,
      thumbnail: v.thumbnail?.url,
      duration: v.durationFormatted,
      channel: v.channel?.name,
      views: v.views,
      url: v.url,
      uploadedAt: v.uploadedAt || "",
      live: v.live || false,
    })));
  } catch (err) {
    console.error("youtube-sr trending failed, trying API:", err.message);
    try {
      const token = await getAccessToken();
      const data = await ytFetch("videos", {
        part: "snippet,contentDetails,statistics",
        chart: "mostPopular",
        regionCode: "US",
        maxResults: 25,
      }, token);
      res.json(data.items.map(mapVideo));
    } catch (e2) {
      console.error("API trending also failed:", e2.message);
      res.status(500).json({ error: "Failed to load trending" });
    }
  }
});

// Play on computer via mpv

let mpvProcess = null;
let nowPlaying = null;
// Persist nowPlaying so reconnects after a server restart can recover
// the YouTube URL even when mpv is on a proxy path (live/DVR proxy's
// mpv `path` property is our own http://.../api/hls-*.m3u8, not the
// youtube.com URL — without persistence we'd have no way to look up
// the title/channel/thumbnail in historyMap).
const NOW_PLAYING_FILE = path.join(__dirname, ".now-playing.json");
try {
  const v = JSON.parse(fs.readFileSync(NOW_PLAYING_FILE, "utf8"));
  if (v?.url) nowPlaying = v.url;
} catch {}
let _lastPersistedNowPlaying = nowPlaying;
function persistNowPlaying() {
  if (nowPlaying === _lastPersistedNowPlaying) return;
  // Never persist a proxy URL — we're looking at that file to *recover*
  // the YouTube URL after a restart, so persisting proxy would defeat
  // the whole mechanism.
  if (typeof nowPlaying === "string" && /\/api\/hls-(live|sub|vod)\.m3u8/.test(nowPlaying)) return;
  _lastPersistedNowPlaying = nowPlaying;
  try { fs.writeFileSync(NOW_PLAYING_FILE, JSON.stringify({ url: nowPlaying, ts: Date.now() })); } catch {}
}
setInterval(persistNowPlaying, 5000);
let windowMode = null; // 'fullscreen' | 'maximize' | 'floating' | null
let _lastPolledPaused = null; // track mpv pause state for auto-hide on external pause (AirPods etc)
// Cache immutable-per-video mpv properties so the WS tick doesn't re-query them every second.
// Invalidated when nowPlaying changes.
let _mpvVideoInfoCache = { url: null, height: null, videoCodec: null, hwdec: null };
let currentMonitor = "lg"; // tracked server-side, updated on move-monitor
let progressInterval = null;
let progressGen = 0; // generation counter to prevent overlapping intervals
let activePlayer = null; // 'mpv' | null — kept for WS clients that check this field
let currentLiveHlsUrl = null; // upstream YouTube HLS URL for the live stream currently playing

app.get("/api/now-playing", (_req, res) => {
  res.json({ url: nowPlaying });
});

function startProgressTracking(url) {
  if (progressInterval) clearInterval(progressInterval);
  const gen = ++progressGen;
  progressInterval = setInterval(async () => {
    if (gen !== progressGen) { clearInterval(progressInterval); return; }
    // Skip IPC + save while paused — position hasn't moved, save is pointless.
    // WS tick keeps _lastPolledPaused up to date.
    if (_lastPolledPaused === true) return;
    try {
      const [pos, dur] = await Promise.all([
        mpvCommand(["get_property", "time-pos"]),
        mpvCommand(["get_property", "duration"]),
      ]);
      if (gen !== progressGen) return;
      if (nowPlaying !== url) { clearInterval(progressInterval); return; }
      if (pos?.data && dur?.data && pos.data < dur.data * 1.05) updateHistoryProgress(url, pos.data, dur.data);
    } catch {}
  }, 10000);
}

let playLock = false;
let playLockAt = 0;
// Auto-release after 45s — guards against pathological hangs in the
// async IIFE below that would otherwise leave the lock stuck and
// silently reject future /api/play calls with { queued: true }.
setInterval(() => {
  if (playLock && Date.now() - playLockAt > 45000) {
    console.warn("playLock auto-released after 45s");
    playLock = false;
  }
}, 5000);
app.post("/api/play", async (req, res) => {
  if (playLock) return res.json({ ok: true, queued: true });
  playLock = true;
  playLockAt = Date.now();
  const { url, isLive: clientIsLive, title: reqTitle, channel: reqChannel, thumbnail: reqThumb, watchPct } = req.body;
  if (!url || (!url.startsWith("https://www.youtube.com/") && !url.startsWith("https://rumble.com/"))) {
    playLock = false;
    return res.status(400).json({ error: "Invalid URL" });
  }
  const isRumble = url.startsWith("https://rumble.com/");

  // Detect live streams server-side if frontend didn't flag it
  let isLive = clientIsLive;
  if (!isLive && !isRumble) {
    try {
      const { stdout } = await execFileP("yt-dlp", ["--cookies", COOKIES_FILE, "--print", "is_live", url], { timeout: 10000 });
      if (stdout.trim() === "True") isLive = true;
    } catch {}
  }

  try {
    // If live, resolve the HLS URL and route mpv through the VOD proxy
    // so DVR scrubbing works inside mpv itself (no VLC needed). The
    // proxy injects `#EXT-X-PLAYLIST-TYPE:VOD` + `#EXT-X-ENDLIST` which
    // makes ffmpeg's HLS demuxer treat the 4-hour DVR window as a VOD
    // and allow free seeking.
    let liveProxyUrl = null;
    if (isLive) {
      try {
        const { stdout } = await execFileP(
          "yt-dlp", ["--cookies", COOKIES_FILE, "-f", "301/300/96/95/94/93", "--get-url", url],
          { timeout: 15000 }
        );
        currentLiveHlsUrl = stdout.trim();
      } catch {}
      subProxyAnchor = null;
      playbackAnchor = null;
      // Kick off mpv PDT tracking so the phone can sync frame-accurately.
      startMpvPdtTracking(currentLiveHlsUrl);
      // Prime manifest stats immediately so /api/seek knows the DVR
      // window size even if user scrubs within the first few seconds.
      try {
        const m = await fetchManifest(currentLiveHlsUrl);
        updateManifestStatsFromText(m);
      } catch {}
      // The proxy URL mpv actually plays. Stable across "go live"
      // reloads — reloading this URL gets a fresh/extended manifest.
      // Default to live proxy — smooth playback without reload skips.
      // Frontend calls /api/enable-dvr to swap to VOD proxy on demand.
      liveProxyUrl = "http://localhost:3000/api/hls-live.m3u8";
    } else {
      stopMpvPdtTracking();
    }

    // What we actually hand to mpv. For live streams this is our VOD
    // proxy URL (so mpv can seek the full 4-hour DVR window); for VODs
    // it's the YouTube watch URL (yt-dlp resolves it inside mpv).
    const playUrl = liveProxyUrl || url;

    const savedEntry = historyMap.get(url);
    const pos = savedEntry?.position || 0;
    const dur = savedEntry?.duration || 0;
    const resumePos = pos > 0 && dur > 0 && pos < dur * 0.95 && pos < dur - 10 ? pos : 0;
    // If mpv is already running, load new video in existing player
    if (mpvProcess) {
      try {
        // Save current video's progress before switching (also verifies mpv is responsive)
        try {
          const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej('timeout'), ms))]);
          const [pos, dur] = await timeout(Promise.all([
            mpvCommand(["get_property", "time-pos"]),
            mpvCommand(["get_property", "duration"]),
          ]), 2000);
          if (pos?.data && dur?.data && nowPlaying) updateHistoryProgress(nowPlaying, pos.data, dur.data);
        } catch {}
        // Stop progress tracking BEFORE switching videos
        if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
        // Load new video + reset state in parallel. Resetting speed to
        // 1.0 is critical — phone-sync's syncVod can leave speed at
        // 0.95-1.05 when drift oscillates, and if sync exits via an
        // unexpected path the mpv process keeps that speed across
        // subsequent playback → audible A/V desync.
        await Promise.all([
          mpvCommand(["loadfile", playUrl, "replace"]),
          mpvCommand(["set_property", "pause", false]).catch(() => {}),
          mpvCommand(["set_property", "mute", false]).catch(() => {}),
          mpvCommand(["set_property", "vid", "auto"]).catch(() => {}),
          mpvCommand(["set_property", "speed", 1.0]).catch(() => {}),
        ]);
        // Pin media-title to the real video title — prevents the proxy
        // pathname leaking through any future media-title read site.
        setMpvForceTitle(reqTitle || historyMap.get(url)?.title || "");
        // Unhide in background (don't await)
        execFile("osascript", ["-e", 'tell application "System Events" to set visible of process "mpv" to true'], () => {});
        nowPlaying = url;
        addToHistory(url, reqTitle || "", reqChannel || "", reqThumb || "");
        // Reset position for this video to prevent stale data from corrupting resume
        const entry = historyMap.get(url);
        if (entry && resumePos <= 0) { entry.position = 0; entry.duration = 0; }
        // Re-apply window mode immediately after loadfile (don't wait for video to load)
        try {
          const wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
          if (wid && windowMode === "maximize") {
            execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" });
            execSync(`aerospace fullscreen --no-outer-gaps on --window-id ${wid}`, { stdio: "ignore" });
          }
        } catch {}
        res.json({ ok: true });
        const expectedUrl = url;
        const oldDuration = await mpvCommand(["get_property", "duration"]).then(r => r?.data || 0).catch(() => 0);
        (async () => {
          try {
          // Wait for NEW video to load (duration changes from old video's)
          let loaded = false;
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (nowPlaying !== expectedUrl) return; // another video was started
            try {
              const d = await mpvCommand(["get_property", "duration"]);
              const t = await mpvCommand(["get_property", "time-pos"]);
              // New video loaded when: duration changed AND time-pos is near start
              if (d?.data > 0 && d.data !== oldDuration) { loaded = true; break; }
              // Or time-pos reset to near 0 (new video started)
              if (d?.data > 0 && t?.data < 5 && i > 2) { loaded = true; break; }
            } catch {}
          }
          if (!loaded) {
            // Remove from history if it never loaded
            history = history.filter(h => h.url !== url);
            saveHistory();
            nowPlaying = null;
            return;
          }
          // Seek to resume position, or compute from YouTube watch
          // percentage. For live streams (VOD-tagged proxy), land at
          // live edge (100%) instead of 0.
          try {
            if (isLive) {
              // Live proxy — small cache window, seek near its end.
              const d = await mpvCommand(["get_property", "duration"]);
              if (d?.data > 5) await mpvCommand(["seek", d.data - 3, "absolute"]);
            } else {
              let seekTo = resumePos;
              if (seekTo <= 0 && watchPct > 0 && watchPct < 95) {
                const actualDur = await mpvCommand(["get_property", "duration"]);
                if (actualDur?.data > 0) seekTo = Math.floor(actualDur.data * watchPct / 100);
              }
              if (seekTo > 0) {
                const actualDur = await mpvCommand(["get_property", "duration"]);
                if (actualDur?.data && seekTo < actualDur.data * 0.95) {
                  await mpvCommand(["seek", seekTo, "absolute"]);
                } else {
                  await mpvCommand(["seek", 0, "absolute"]);
                }
              } else {
                await mpvCommand(["seek", 0, "absolute"]);
              }
            }
          } catch {}
          // Re-apply window mode again after video loads (aspect ratio change can disrupt it)
          try {
            const wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
            if (wid) {
              if (windowMode === "maximize") {
                execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" });
                execSync(`aerospace fullscreen --no-outer-gaps on --window-id ${wid}`, { stdio: "ignore" });
              } else if (windowMode === "floating") {
                try {
                  const posStr = execSync(`osascript -e 'tell application "System Events" to get position of first window of process "mpv"'`, { encoding: "utf8" }).trim();
                  const [wx] = posStr.split(", ").map(Number);
                  const screens = getScreenOrigins();
                  const screen = screens.find(s => wx >= s.x && wx < s.x + s.w) || screens.find(s => s.isMain) || screens[0];
                  const w = Math.round(screen.w * 0.38);
                  const h = Math.round(w * 9 / 16);
                  const posX = screen.x + screen.w - w - 12;
                  const posY = screen.y + 38;
                  execSync(`osascript -e 'tell application "System Events" to tell process "mpv" to set size of first window to {${w}, ${h}}'`, { stdio: "ignore" });
                  execSync(`osascript -e 'tell application "System Events" to tell process "mpv" to set position of first window to {${posX}, ${posY}}'`, { stdio: "ignore" });
                } catch {}
                await floatTopRight(wid);
              }
            }
          } catch {}
          try {
            const t = await mpvCommand(["get_property", "media-title"]);
            // Live streams playing our proxy report the URL basename
            // ("hls-live.m3u8") as media-title; reject those or they
            // poison history and blank out the lock-screen widget.
            if (t?.data && !/\.m3u8($|\?)/.test(t.data)) { history[0].title = t.data; saveHistory(); }
          } catch {}
          markWatchedOnYouTube(url);
          startProgressTracking(url);
          } finally {
            playLock = false;
          }
        })();
        return;
      } catch {}
    }

    // No existing player or IPC failed — spawn new one
    try { execSync("pkill -9 mpv", { stdio: "ignore" }); } catch {}
    mpvProcess = null;
    await new Promise(r => setTimeout(r, 200));
    try { require("fs").unlinkSync("/tmp/mpv-socket"); } catch {}

    // Calculate geometry for floating mode so mpv starts in the right place
    let geometry = "";
    if (!windowMode || windowMode === "floating") {
      geometry = "38%-12+38";
    }
    const mpvArgs = [`--input-ipc-server=/tmp/mpv-socket`, `--ytdl-raw-options=cookies=${COOKIES_FILE}`, `--hwdec=auto-safe`, `--keep-open`, `--demuxer-max-back-bytes=512M`, `--cache=yes`, `--autosync=30`];
    // Pin media-title so live streams don't report "hls-live.m3u8" etc.
    // See setMpvForceTitle for context — sanitize to strip control
    // chars that can crash mpv's arg parser on some builds.
    const cleanTitle = sanitizeMpvTitle(reqTitle);
    if (cleanTitle) mpvArgs.push(`--force-media-title=${cleanTitle}`);
    if (geometry) mpvArgs.push(`--geometry=${geometry}`, `--ontop`);
    if (windowMode === "fullscreen") mpvArgs.push(`--fs`);
    mpvArgs.push(playUrl);
    if (isLive) {
      // Live proxy has ~15s cache, so start near that cache's end.
      mpvArgs.push(`--start=-3`);
    } else if (resumePos > 0) mpvArgs.push(`--start=${Math.floor(resumePos)}`);
    else if (watchPct > 0 && watchPct < 95) mpvArgs.push(`--start=${Math.floor(watchPct)}%`);

    // Focus LG workspace so mpv spawns there
    try { execSync("aerospace workspace 1", { stdio: "ignore" }); } catch {}

    // Capture stderr to a rolling buffer. Previously stdio:"ignore"
    // dropped everything, making crash diagnostics impossible. On
    // abnormal exit we dump the tail of this buffer.
    const child = spawn("mpv", mpvArgs, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child._stderr = "";
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        child._stderr += chunk.toString();
        // Cap at 32KB to avoid unbounded memory on long runs
        if (child._stderr.length > 32 * 1024) child._stderr = child._stderr.slice(-16 * 1024);
      });
    }

    mpvProcess = child;
    activePlayer = "mpv";
    nowPlaying = url;
    if (!windowMode) windowMode = "floating";

    // Apply current window mode after mpv window appears
    const targetMode = windowMode;
    const applyWindowMode = async () => {
      // Wait for mpv window to appear in aerospace
      let wid = "";
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 200));
        wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
        if (wid) break;
      }
      if (!wid) return;
      await new Promise(r => setTimeout(r, 300));
      try {
        if (targetMode === "fullscreen") {
          await mpvCommand(["set_property", "fullscreen", true]);
        } else if (targetMode === "maximize") {
          execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" });
          execSync(`aerospace fullscreen --no-outer-gaps on --window-id ${wid}`, { stdio: "ignore" });
        } else {
          await floatTopRight(wid);
        }
      } catch {}
    };
    applyWindowMode();
    addToHistory(url, reqTitle || "", reqChannel || "", reqThumb || "");

    // Wait for video to load, then set up progress (remove from history if failed)
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
    setTimeout(async () => {
      try {
        const d = await mpvCommand(["get_property", "duration"]);
        if (!d?.data || d.data <= 0) {
          history = history.filter(h => h.url !== url);
          saveHistory();
          return;
        }
      } catch {
        history = history.filter(h => h.url !== url);
        saveHistory();
        return;
      }
      try {
        const t = await mpvCommand(["get_property", "media-title"]);
        // Reject proxy-pathname titles (live streams playing our
        // hls-live.m3u8 proxy report that as media-title).
        if (t?.data && !/\.m3u8($|\?)/.test(t.data)) { history[0].title = t.data; saveHistory(); }
      } catch {}
      markWatchedOnYouTube(url);
      startProgressTracking(url);
    }, 5000);

    child.on("exit", async (code, signal) => {
      progressGen++;
      if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
      const elapsed = Date.now() - child._startTime;
      const abnormal = (code && code !== 0) || signal;
      if (abnormal) {
        const tail = (child._stderr || "").slice(-2048);
        console.error(`mpv exited abnormally: code=${code} signal=${signal} after ${Math.round(elapsed/1000)}s`);
        if (tail) console.error(`mpv stderr tail:\n${tail}`);
        // Persist the tail to a file for post-mortem debugging.
        try { fs.writeFileSync("/tmp/ytctl-mpv-crash.log", `${new Date().toISOString()} code=${code} signal=${signal}\n${tail}\n`); } catch {}
      }
      if (mpvProcess === child) {
        // If mpv exited within 5 seconds, it probably failed — remove from history
        if (elapsed < 5000 && code !== 0) {
          history = history.filter(h => h.url !== url);
          saveHistory();
        }
        mpvProcess = null;
        nowPlaying = null;
      }
    });
    child._startTime = Date.now();

    playLock = false;
    res.json({ ok: true });
  } catch (err) {
    playLock = false;
    console.error("Play error:", err);
    res.status(500).json({ error: "Failed to play video" });
  }
});

// Stop playback
app.post("/api/stop", async (_req, res) => {
  killPhoneStream();
  try {
    const [pos, dur] = await Promise.all([
      mpvCommand(["get_property", "time-pos"]),
      mpvCommand(["get_property", "duration"]),
    ]);
    if (pos?.data && dur?.data && nowPlaying) updateHistoryProgress(nowPlaying, pos.data, dur.data);
  } catch {}
  progressGen++;
  if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
  try { execSync("pkill -x mpv", { stdio: "ignore" }); } catch {}
  mpvProcess = null;
  nowPlaying = null;
  activePlayer = null;
  stopMpvPdtTracking();
  res.json({ ok: true });
});

// Persistent IPC connection to mpv — reused across requests
const MPV_SOCKET = "/tmp/mpv-socket";
let _mpvClient = null;
let _mpvBuf = "";
let _mpvReqId = 0;
const _mpvPending = new Map(); // request_id -> { resolve, timer }

function _mpvCleanup(err) {
  if (_mpvClient) { try { _mpvClient.destroy(); } catch {} }
  _mpvClient = null;
  _mpvBuf = "";
  // Fail all pending
  for (const [, p] of _mpvPending) {
    clearTimeout(p.timer);
    p.resolve(null);
  }
  _mpvPending.clear();
}

function _mpvGetClient() {
  if (_mpvClient) return _mpvClient;
  const client = net.createConnection(MPV_SOCKET);
  _mpvClient = client;
  client.on("data", (chunk) => {
    _mpvBuf += chunk;
    const lines = _mpvBuf.split("\n");
    _mpvBuf = lines.pop() || "";
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        const rid = parsed.request_id;
        if (rid !== undefined && _mpvPending.has(rid)) {
          const p = _mpvPending.get(rid);
          _mpvPending.delete(rid);
          clearTimeout(p.timer);
          p.resolve(parsed);
        }
      } catch {}
    }
  });
  client.on("error", _mpvCleanup);
  client.on("close", _mpvCleanup);
  return client;
}

function mpvCommand(cmd) {
  return new Promise((resolve) => {
    let client;
    try { client = _mpvGetClient(); } catch { return resolve(null); }
    const rid = ++_mpvReqId;
    const timer = setTimeout(() => {
      if (_mpvPending.has(rid)) { _mpvPending.delete(rid); resolve(null); }
    }, 2000);
    _mpvPending.set(rid, { resolve, timer });
    try {
      client.write(JSON.stringify({ command: cmd, request_id: rid }) + "\n");
    } catch {
      clearTimeout(timer);
      _mpvPending.delete(rid);
      _mpvCleanup();
      resolve(null);
    }
  });
}

// Override mpv's media-title so that get_property "media-title" always
// returns the real video title, even when mpv is playing a proxy URL
// whose basename would otherwise leak ("hls-live.m3u8"). Call after
// every `loadfile` where we know the real title — reads downstream
// (/api/playback, reconnect, any future code) see the real value.
// Strip control chars — mpv's property setter can choke on embedded
// newlines / nulls in force-media-title, occasionally crashing the
// process on certain builds.
function sanitizeMpvTitle(t) {
  if (!t) return "";
  // Drop C0 controls except space, strip BOM, collapse whitespace.
  return String(t).replace(/[\x00-\x1f\x7f\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, 512);
}
async function setMpvForceTitle(title) {
  const clean = sanitizeMpvTitle(title);
  if (!clean) return;
  try { await mpvCommand(["set_property", "force-media-title", clean]); } catch {}
}

// Get playback position
app.get("/api/playback", async (_req, res) => {
  if (!mpvProcess || !nowPlaying) {
    return res.json({ playing: false });
  }
  try {
    const [pos, dur, title, paused, fileFormat, fs] = await Promise.all([
      mpvCommand(["get_property", "time-pos"]),
      mpvCommand(["get_property", "duration"]),
      mpvCommand(["get_property", "media-title"]),
      mpvCommand(["get_property", "pause"]).catch(() => ({ data: false })),
      mpvCommand(["get_property", "file-format"]).catch(() => ({ data: "" })),
      mpvCommand(["get_property", "fullscreen"]).catch(() => ({ data: false })),
    ]);
    const isLive = (fileFormat?.data || "").includes("hls");
    // Sync windowMode from actual mpv fullscreen state
    if (fs?.data && windowMode !== "fullscreen") windowMode = "fullscreen";
    else if (!fs?.data && windowMode === "fullscreen") windowMode = "floating";
    res.json({
      playing: true,
      url: nowPlaying,
      position: pos?.data || 0,
      duration: dur?.data || 0,
      title: title?.data || "",
      channel: historyMap.get(nowPlaying)?.channel || "",
      paused: paused?.data || false,
      fullscreen: fs?.data || false,
      isLive,
      windowMode,
      monitor: currentMonitor,
    });
  } catch {
    res.json({ playing: !!nowPlaying, url: nowPlaying, position: 0, duration: 0, title: "" });
  }
});

// Seek absolute
app.post("/api/seek", async (req, res) => {
  const { position } = req.body;
  if (typeof position !== "number") return res.status(400).json({ error: "Invalid position" });
  try {
    const pathR = await mpvCommand(["get_property", "path"]).catch(() => null);
    const onLiveProxy = !!pathR?.data?.includes("/api/hls-live.m3u8");
    const onSubProxy = !!pathR?.data?.includes("/api/hls-sub.m3u8");

    // Frontend's `position` is in scrubber space [0, lastManifestFullDuration]
    // with live edge at the right. behindLive is how many seconds back
    // from real live edge the user wants.
    if ((onLiveProxy || onSubProxy) && lastManifestFullDuration > 0) {
      const dur = await mpvCommand(["get_property", "duration"]).catch(() => null);
      const mpvDur = dur?.data || 0;
      const behindLive = Math.max(0, lastManifestFullDuration - position);

      if (behindLive < mpvDur) {
        // Target is within mpv's current seekable window — seek directly,
        // no swap, no skip. Works for both live-proxy (small window) and
        // sub-proxy (whatever window was loaded).
        const localTarget = Math.max(0, mpvDur - behindLive);
        await mpvCommand(["seek", localTarget, "absolute"]);
        return res.json({ ok: true });
      }

      // Target outside current window — load a sub-manifest starting
      // ~behindLive before live edge. Sub-manifest is live-style so
      // mpv auto-polls and catches up to live naturally.
      //
      // `live_start_index=0` forces mpv to start at the FIRST segment
      // of the sub-window (= behindLive behind real live edge). Without
      // this, ffmpeg's HLS demuxer defaults to -3 (near the end) and
      // the user would land back at live edge instead of their seek
      // target. Setting via file-local-options so subsequent loadfiles
      // (of the full live proxy) aren't affected.
      const wasPaused = (await mpvCommand(["get_property", "pause"]).catch(() => null))?.data === true;
      // Resolve behind→absolute media-sequence NOW. The proxy pins to
      // this sequence for all subsequent polls from mpv, so segments
      // never shift under mpv's cache.
      const fromSeq = await resolveBehindToFromSeq(Math.ceil(behindLive) + 10);
      const subUrl = `http://localhost:3000/api/hls-sub.m3u8?from_seq=${fromSeq}`;
      // Capture the content PDT the user intends to land at — derived
      // from current live edge once, at seek time. After this, the
      // scrubber's userPdt advances purely from mpv's own time-pos
      // progress (not re-derived from liveEdge each WS tick, which
      // jitters ~1s on manifest refresh and made phone sync chase).
      const liveEdgeAtSeek = lastManifestEdgeEpochMs
        ? lastManifestEdgeEpochMs + (Date.now() - lastManifestFetchedAt)
        : Date.now();
      const userPdtAtSeek = liveEdgeAtSeek - behindLive * 1000;
      // Pre-seed subProxyAnchor with mpvPosAtAnchor=0 synchronously
      // BEFORE loadfile. Since we pass `start=0,live_start_index=0`,
      // mpv will start playback from position 0 in the sub-proxy window,
      // so timePos=0 at anchor time is correct. The WS broadcast formula
      // `userPdt = userPdtAtAnchor + (timePos - mpvPosAtAnchor) * 1000`
      // immediately places the scrubber at the user's intended point,
      // instead of showing a transient drift/zero while we poll for
      // mpv's first real time-pos reading. Without this pre-seed, the
      // thumb visibly snaps to the wrong edge for up to a full WS tick
      // before the anchor is populated by the async poll.
      subProxyAnchor = {
        wallMs: Date.now(),
        mpvPosAtAnchor: 0,
        behindLive,
        userPdtAtAnchor: userPdtAtSeek,
      };
      await mpvCommand(["loadfile", subUrl, "replace", -1, "start=0,demuxer-lavf-o=live_start_index=0"]);
      setMpvForceTitle(historyMap.get(nowPlaying)?.title || "");
      // Reset speed in case syncVod left it off-1.0 before this scrub.
      await mpvCommand(["set_property", "speed", 1.0]).catch(() => {});
      if (!wasPaused) await mpvCommand(["set_property", "pause", false]);

      // Refine the anchor once mpv reports a stable non-zero time-pos.
      // The pre-seeded `mpvPosAtAnchor=0` handles the transient window
      // (scrubber doesn't flash), but after `start=0,live_start_index=0`
      // mpv's actual time-pos might settle at some small non-zero
      // offset depending on segment PTS. When it does, shift the
      // anchor so subsequent ticks' `(timePos - mpvPosAtAnchor)` delta
      // starts from the right baseline. userPdtAtAnchor stays pinned
      // to the user's intended PDT — we're only re-zeroing the mpv
      // side of the correspondence.
      (async () => {
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 100));
          const p = await mpvCommand(["get_property", "time-pos"]).catch(() => null);
          if (p?.data != null && p.data > 0.1) {
            if (subProxyAnchor) {
              subProxyAnchor.mpvPosAtAnchor = p.data;
              subProxyAnchor.wallMs = Date.now();
            }
            return;
          }
        }
      })();
      return res.json({ ok: true });
    }

    // Non-live / fallback — seek directly.
    await mpvCommand(["seek", position, "absolute"]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Seek failed: " + err.message });
  }
});


// Seek relative (skip forward/back)
app.post("/api/seek-relative", async (req, res) => {
  const { offset } = req.body;
  if (typeof offset !== "number") return res.status(400).json({ error: "Invalid offset" });
  try {
    await mpvCommand(["seek", offset, "relative"]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Seek failed" });
  }
});

// Fetch HLS manifest helper — short TTL cache to avoid redundant fetches on rapid seeks
const _manifestCache = new Map(); // url -> { at, data, inflight }
const MANIFEST_TTL_MS = 2500;
function fetchManifest(url) {
  const now = Date.now();
  const entry = _manifestCache.get(url);
  if (entry) {
    if (entry.data && now - entry.at < MANIFEST_TTL_MS) return Promise.resolve(entry.data);
    if (entry.inflight) return entry.inflight;
  }
  const https = require('https');
  const http = require('http');
  const get = url.startsWith('https') ? https.get : http.get;
  const p = new Promise((resolve, reject) => {
    const req = get(url, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d));
    }).on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('fetchManifest timeout')); }, 5000);
  }).then(data => {
    _manifestCache.set(url, { at: Date.now(), data, inflight: null });
    // Keep cache bounded
    if (_manifestCache.size > 8) {
      const oldest = [..._manifestCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) _manifestCache.delete(oldest[0]);
    }
    return data;
  }).catch(err => {
    _manifestCache.delete(url);
    throw err;
  });
  _manifestCache.set(url, { at: now, data: entry?.data || null, inflight: p });
  return p;
}

// Parse HLS manifest once — returns { lines, totalDuration, liveEdgePdt }
function parseHlsManifest(manifest) {
  const lines = manifest.split('\n');
  let totalDuration = 0;
  let lastPdtMs = 0;
  let durAfterLastPdt = 0;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const dur = parseFloat(line.split(':')[1]);
      totalDuration += dur;
      durAfterLastPdt += dur;
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      lastPdtMs = new Date(line.substring('#EXT-X-PROGRAM-DATE-TIME:'.length).trim()).getTime();
      durAfterLastPdt = 0;
    }
  }
  return {
    lines,
    totalDuration,
    liveEdgePdt: lastPdtMs > 0 ? lastPdtMs + durAfterLastPdt * 1000 : 0,
  };
}

// HLS VOD proxy — serves the current live stream's manifest with
// `#EXT-X-PLAYLIST-TYPE:VOD` + `#EXT-X-ENDLIST` injected. ffmpeg/mpv's
// HLS demuxer refuses to seek past its local cache on live manifests,
// but honors the full segment list when the manifest is tagged VOD.
// Since YouTube's live manifest already contains 4 hours of segment
// URLs, this lets mpv seek anywhere in the DVR window via plain HTTP
// GETs — no VLC needed.
//
// Tradeoff: once mpv loads this as VOD it won't auto-refresh. To catch
// up to live edge, call `loadfile` on the same URL — YouTube returns a
// fresh manifest with a longer window.
// Two proxy endpoints for the same live stream, used in different modes:
//
//   /api/hls-live.m3u8  — pass through unchanged. mpv treats this as a
//     live stream, auto-polls for new segments, plays smoothly with no
//     reload skips. Scrub-back limited to ffmpeg's HLS cache window
//     (~15-30s), because ffmpeg's HLS demuxer clamps the seekable range
//     to the cached window regardless of cache size settings.
//
//   /api/hls-vod.m3u8  — injects EXT-X-PLAYLIST-TYPE:VOD + ENDLIST.
//     mpv treats the full manifest as a finite VOD, enabling seek-back
//     across the entire 4h DVR window. Downside: mpv stops polling
//     the manifest, so it'll eventually EOF when it plays through
//     what was captured in that snapshot (no periodic reload).
//
// Hybrid playback: default is the live proxy for smooth watching.
// When user scrubs past mpv's cache, `/api/seek` transparently swaps
// to the VOD proxy and seeks there (one skip). User stays on VOD
// until they tap LIVE (hits `/api/go-live`), which swaps back.
// Track the full DVR window duration (sum of all EXTINFs in YouTube's
// manifest) + live-edge PDT so the scrubber UI can show the real 4h
// context and the thumb keeps advancing as YouTube produces new
// segments, even while mpv plays a static VOD snapshot.
let lastManifestFullDuration = 0;      // total seconds of DVR window
let lastManifestEdgeEpochMs = 0;       // PDT of the last segment (= live edge)
let lastManifestFetchedAt = 0;         // Date.now() when we read it
let lastManifestTargetDur = 5;         // #EXT-X-TARGETDURATION — segment length in seconds

function updateManifestStatsFromText(manifest) {
  let total = 0;
  let lastPdt = null;
  let durSinceLastPdt = 0;
  let targetDur = 0;
  const lines = manifest.split("\n");
  for (const line of lines) {
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDur = parseFloat(line.split(":")[1]) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      lastPdt = new Date(line.substring("#EXT-X-PROGRAM-DATE-TIME:".length).trim()).getTime();
      durSinceLastPdt = 0;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const d = parseFloat(line.split(":")[1]) || 0;
      total += d;
      durSinceLastPdt += d;
    }
  }
  if (total > 60) lastManifestFullDuration = total;
  if (targetDur > 0) lastManifestTargetDur = targetDur;
  if (lastPdt) {
    lastManifestEdgeEpochMs = lastPdt + durSinceLastPdt * 1000;
    lastManifestFetchedAt = Date.now();
  }
}
// Default live proxy — full manifest, mpv starts near live edge.
app.get("/api/hls-live.m3u8", async (_req, res) => {
  if (!currentLiveHlsUrl) return res.status(400).send("No HLS URL");
  try {
    const manifest = await fetchManifest(currentLiveHlsUrl);
    updateManifestStatsFromText(manifest);
    res.type("application/vnd.apple.mpegurl").send(manifest);
  } catch (e) {
    res.status(500).send("Proxy error: " + e.message);
  }
});

// Sub-live proxy — serves all segments with media-sequence >= `from_seq`.
//
// The starting point is an ABSOLUTE media-sequence (pinned at seek
// time), not a "N seconds behind live" offset. This means as YouTube
// produces new segments and mpv re-polls this URL, mpv sees the same
// segments it already cached plus new ones appended at the end. mpv's
// cached segments never shift under it, so time-pos advances at 1x.
//
// If caller passes `?from_seq=X`, use that. If they pass `?behind=N`,
// we compute `from_seq = current_live_media_sequence - segments_for_N`
// on THIS fetch — callers should always pin with `from_seq` after the
// initial resolution.
app.get("/api/hls-sub.m3u8", async (req, res) => {
  if (!currentLiveHlsUrl) return res.status(400).send("No HLS URL");
  const fromSeqParam = parseInt(req.query.from_seq);
  const behindParam = Math.max(30, Math.min(14400, parseInt(req.query.behind) || 120));
  try {
    const manifest = await fetchManifest(currentLiveHlsUrl);
    updateManifestStatsFromText(manifest);
    const lines = manifest.split("\n");
    const seqMatch = manifest.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    const origFirstSeq = seqMatch ? parseInt(seqMatch[1]) : 0;
    const segs = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXTINF:")) {
        segs.push({ idx: i, dur: parseFloat(lines[i].split(":")[1]) || 0 });
      }
    }
    if (!segs.length) return res.type("application/vnd.apple.mpegurl").send(manifest);

    // Determine first keep index based on from_seq (absolute) or behind (relative).
    let firstKeepIdx;
    if (Number.isFinite(fromSeqParam) && fromSeqParam >= origFirstSeq) {
      firstKeepIdx = Math.min(segs.length - 1, fromSeqParam - origFirstSeq);
    } else if (Number.isFinite(fromSeqParam)) {
      // from_seq rolled off the front of the live manifest — clamp to oldest.
      firstKeepIdx = 0;
    } else {
      // behind mode — compute backward from end.
      let acc = 0;
      firstKeepIdx = 0;
      for (let j = segs.length - 1; j >= 0; j--) {
        acc += segs[j].dur;
        if (acc >= behindParam) { firstKeepIdx = j; break; }
      }
    }
    const headerEnd = segs[0].idx;
    const header = lines.slice(0, headerEnd).map((l) => {
      if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        return `#EXT-X-MEDIA-SEQUENCE:${origFirstSeq + firstKeepIdx}`;
      }
      return l;
    });
    const body = lines.slice(segs[firstKeepIdx].idx);
    res.type("application/vnd.apple.mpegurl").send([...header, ...body].join("\n"));
  } catch (e) {
    res.status(500).send("Proxy error: " + e.message);
  }
});

// Resolve a "behind seconds" request to an absolute media-sequence the
// sub-proxy can pin to. Caller (/api/seek) uses this once at seek time.
async function resolveBehindToFromSeq(behindSec) {
  const manifest = await fetchManifest(currentLiveHlsUrl);
  const lines = manifest.split("\n");
  const seqMatch = manifest.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
  const origFirstSeq = seqMatch ? parseInt(seqMatch[1]) : 0;
  const segs = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXTINF:")) {
      segs.push(parseFloat(lines[i].split(":")[1]) || 0);
    }
  }
  let acc = 0;
  let firstKeepIdx = 0;
  for (let j = segs.length - 1; j >= 0; j--) {
    acc += segs[j];
    if (acc >= behindSec) { firstKeepIdx = j; break; }
  }
  return origFirstSeq + firstKeepIdx;
}

app.get("/api/hls-vod.m3u8", async (_req, res) => {
  if (!currentLiveHlsUrl) return res.status(400).send("No HLS URL");
  try {
    const manifest = await fetchManifest(currentLiveHlsUrl);
    const lines = manifest.split("\n");
    const out = [];
    let typeInserted = false;
    for (const line of lines) {
      out.push(line);
      if (!typeInserted && line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
        out.push("#EXT-X-PLAYLIST-TYPE:VOD");
        typeInserted = true;
      }
    }
    if (!manifest.includes("#EXT-X-ENDLIST")) out.push("#EXT-X-ENDLIST");
    res.type("application/vnd.apple.mpegurl").send(out.join("\n"));
  } catch (e) {
    res.status(500).send("Proxy error: " + e.message);
  }
});

// Switch mpv from live to VOD proxy (for scrub-back). Lands at what
// would be "live edge" in the VOD timeline (= duration - 15) so the
// user's apparent position stays continuous.
app.post("/api/enable-dvr", async (_req, res) => {
  if (activePlayer !== "mpv" || !currentLiveHlsUrl) return res.status(400).json({ error: "No live stream" });
  try {
    const p = await mpvCommand(["get_property", "path"]);
    if (p?.data?.includes("/api/hls-vod.m3u8")) return res.json({ ok: true, alreadyInDvr: true });
    const wasPaused = await mpvCommand(["get_property", "pause"]);
    await mpvCommand(["loadfile", "http://localhost:3000/api/hls-vod.m3u8", "replace"]);
    setMpvForceTitle(historyMap.get(nowPlaying)?.title || "");
    // Poll for new duration, seek to near-live edge in the VOD frame.
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      const nd = await mpvCommand(["get_property", "duration"]).catch(() => null);
      if (nd?.data > 60) {
        await mpvCommand(["seek", Math.max(0, nd.data - 15), "absolute"]);
        if (!wasPaused?.data) await mpvCommand(["set_property", "pause", false]);
        break;
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Switch mpv to the full live proxy and seek to its live edge. Used
// when user taps "LIVE" while scrubbed back onto a sub-proxy window.
app.post("/api/go-live", async (_req, res) => {
  if (activePlayer !== "mpv" || !currentLiveHlsUrl) return res.status(400).json({ error: "No live stream" });
  try {
    const p = await mpvCommand(["get_property", "path"]);
    if (p?.data?.includes("/api/hls-live.m3u8")) {
      const d = await mpvCommand(["get_property", "duration"]);
      if (d?.data > 5) await mpvCommand(["seek", d.data - 3, "absolute"]);
      // Seek within live proxy still invalidates the existing anchor's
      // time-pos correspondence — drop it so WS recaptures at the new
      // position.
      playbackAnchor = null;
      return res.json({ ok: true, alreadyLive: true });
    }
    const wasPaused = await mpvCommand(["get_property", "pause"]);
    // Clear both anchors. playbackAnchor is bucketed by proxy path,
    // but going live → sub-proxy → live keeps the path the same, so
    // the WS capture condition (`path !== mpvPath.data`) would never
    // refire and the stale anchor would report the PREVIOUS
    // behind-live value (whatever the user scrubbed to last).
    playbackAnchor = null;
    subProxyAnchor = null;
    await mpvCommand(["loadfile", "http://localhost:3000/api/hls-live.m3u8", "replace"]);
    setMpvForceTitle(historyMap.get(nowPlaying)?.title || "");
    await mpvCommand(["set_property", "speed", 1.0]).catch(() => {});
    if (!wasPaused?.data) await mpvCommand(["set_property", "pause", false]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lightweight HLS proxy for phone — only last ~120s of segments (full manifest is 5MB+)
app.get("/api/phone-hls", async (req, res) => {
  if (!currentLiveHlsUrl) return res.status(400).send("No HLS URL");
  try {
    const manifest = await fetchManifest(currentLiveHlsUrl);
    const { lines } = parseHlsManifest(manifest);
    // Parse segments with their PDT tags
    const segLines = [];
    let lastPdt = null;
    let durSinceLastPdt = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        lastPdt = new Date(lines[i].substring('#EXT-X-PROGRAM-DATE-TIME:'.length).trim()).getTime();
        durSinceLastPdt = 0;
      }
      if (lines[i].startsWith('#EXTINF:')) {
        const dur = parseFloat(lines[i].split(':')[1]);
        segLines.push({ idx: i, dur, pdtMs: lastPdt ? lastPdt + durSinceLastPdt * 1000 : null });
        durSinceLastPdt += dur;
      }
    }
    // Always serve ~120s ending at live edge (mpv owns DVR seeking now,
    // phone just follows live in sync mode or plays independently).
    const trimEnd = segLines.length;
    let keepDur = 0;
    let keepFrom = trimEnd;
    for (let i = trimEnd - 1; i >= 0; i--) {
      keepDur += segLines[i].dur;
      keepFrom = i;
      if (keepDur >= 120) break;
    }
    if (keepFrom >= segLines.length) return res.status(500).send("No segments");
    // Build clean minimal manifest
    const seqMatch = manifest.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    const origSeq = seqMatch ? parseInt(seqMatch[1]) : 0;
    const newSeq = origSeq + keepFrom;
    const tdMatch = manifest.match(/#EXT-X-TARGETDURATION:(\d+)/);
    const td = tdMatch ? tdMatch[1] : '2';
    const keepPdt = segLines[keepFrom].pdtMs;
    // Minimal header + EXTINF+URL pairs with proxied segment URLs for CORS
    let out = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${td}\n#EXT-X-MEDIA-SEQUENCE:${newSeq}\n`;
    if (keepPdt) out += `#EXT-X-PROGRAM-DATE-TIME:${new Date(keepPdt).toISOString()}\n`;
    for (let i = keepFrom; i < trimEnd; i++) {
      const seg = segLines[i];
      out += lines[seg.idx] + '\n'; // #EXTINF
      const segUrl = lines[seg.idx + 1]?.trim();
      // ?direct=1: serve YouTube CDN URLs directly (Safari native HLS, no CORS)
      // default: proxy through our server (hls.js on Chrome needs this for CORS)
      if (req.query.direct && segUrl) {
        out += segUrl + '\n';
      } else if (segUrl && segUrl.startsWith('http')) {
        out += `/api/hls-seg?url=${encodeURIComponent(segUrl)}\n`;
      } else {
        out += (segUrl || '') + '\n';
      }
    }
    res.type('application/vnd.apple.mpegurl').send(out);
  } catch (e) {
    res.status(500).send("Phone HLS error: " + e.message);
  }
});

// HLS segment proxy — passes through video segments from YouTube CDN (avoids CORS for hls.js)
app.get("/api/hls-seg", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing url");
  try {
    const https = require('https');
    const http = require('http');
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (upstream) => {
      res.set('Content-Type', upstream.headers['content-type'] || 'video/mp2t');
      res.set('Cache-Control', 'public, max-age=30');
      upstream.pipe(res);
    }).on('error', (e) => res.status(502).send(e.message));
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Stream-epoch wall-clock for the mpv live-HLS path — the wall-clock of
// PTS=0. Zero means "not calibrated / not live".
let mpvPdtEpochMs = 0;
let mpvPdtRefreshInterval = null;
let syncOffsetMs = 0; // tunable offset for drift calibration (milliseconds)
const SYNC_OFFSET_FILE = ".sync-offset.json";
try {
  const v = JSON.parse(fs.readFileSync(SYNC_OFFSET_FILE, "utf8"));
  if (typeof v.ms === "number") syncOffsetMs = v.ms;
} catch {}
app.post("/api/sync-offset", (req, res) => {
  syncOffsetMs = (req.body.ms || 0);
  console.log("  Sync offset:", syncOffsetMs, "ms");
  try { fs.writeFileSync(SYNC_OFFSET_FILE, JSON.stringify({ ms: syncOffsetMs })); } catch {}
  res.json({ ok: true, ms: syncOffsetMs });
});
app.get("/api/sync-offset", (_req, res) => { res.json({ ms: syncOffsetMs }); });

// Parse first PTS from MPEG-TS segment buffer
function extractFirstPts(buf) {
  const SYNC = 0x47, PKT = 188;
  let syncOff = -1;
  for (let i = 0; i < Math.min(buf.length, PKT * 2); i++) {
    if (buf[i] === SYNC && (i + PKT >= buf.length || buf[i + PKT] === SYNC)) { syncOff = i; break; }
  }
  if (syncOff === -1) return null;
  for (let off = syncOff; off + PKT <= buf.length; off += PKT) {
    if (buf[off] !== SYNC) continue;
    const payloadStart = (buf[off + 1] & 0x40) !== 0;
    const pid = ((buf[off + 1] & 0x1F) << 8) | buf[off + 2];
    const afc = (buf[off + 3] & 0x30) >> 4;
    if (!payloadStart || !(afc & 1) || pid === 0x1FFF || pid === 0) continue;
    let p = off + 4;
    if (afc === 3) p += 1 + buf[p]; // skip adaptation field
    if (p + 14 > buf.length) continue;
    if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) continue;
    const sid = buf[p + 3];
    if (!((sid >= 0xC0 && sid <= 0xEF) || sid === 0xBD)) continue;
    if (((buf[p + 7] & 0xC0) >> 6) === 0) continue; // no PTS
    const q = p + 9;
    if (q + 5 > buf.length || !(buf[q + 2] & 1) || !(buf[q + 4] & 1)) continue;
    const hi3 = (buf[q] & 0x0E) >>> 1;
    const mid15 = (buf[q + 1] << 7) | ((buf[q + 2] & 0xFE) >>> 1);
    const low15 = (buf[q + 3] << 7) | ((buf[q + 4] & 0xFE) >>> 1);
    const pts = Number((BigInt(hi3) << 30n) | (BigInt(mid15) << 15n) | BigInt(low15));
    return pts / 90000; // seconds
  }
  return null;
}

// Fetch first N bytes of a URL (supports Range requests)
async function fetchHead(url, bytes) {
  const mod = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    mod.get(url, { headers: { Range: `bytes=0-${bytes - 1}` } }, r => {
      const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
}

// Capture the PDT↔PTS mapping for an HLS stream. Returns the "stream epoch":
// the wall-clock ms corresponding to stream PTS=0, so any player-reported
// PTS-based position can be converted to absolute wall-clock via
// `pdtEpochMs + positionSeconds * 1000`. Returns null if the manifest lacks
// #EXT-X-PROGRAM-DATE-TIME or the fetch fails.
async function capturePdtEpoch(hlsUrl, label = "PDT") {
  try {
    const manifest = await fetchManifest(hlsUrl);
    const lines = manifest.split('\n');
    const pdtMatch = manifest.match(/#EXT-X-PROGRAM-DATE-TIME:(.+)/);
    const seqMatch = manifest.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    if (!pdtMatch) return null;
    const pdtMs = new Date(pdtMatch[1].trim()).getTime();
    const mediaSeq = seqMatch ? parseInt(seqMatch[1]) : 0;

    // Find the first segment URL (line after the first #EXTINF)
    let segUrl = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXTINF:') && i + 1 < lines.length) {
        segUrl = lines[i + 1].trim();
        break;
      }
    }

    if (segUrl) {
      try {
        const segBuf = await fetchHead(segUrl, 10240);
        const segPts = extractFirstPts(segBuf);
        if (segPts !== null) {
          // Precise: segment's PDT corresponds to its PTS. Stream epoch is
          // the wall-clock of PTS=0: epoch = PDT_of_segment - PTS_of_segment.
          const epochMs = pdtMs - segPts * 1000;
          console.log(`  ${label} (PTS): seq=${mediaSeq} segPTS=${segPts.toFixed(1)}s → streamStart=${new Date(epochMs).toISOString()}`);
          return epochMs;
        }
      } catch (e) { console.error(`  ${label} PTS extraction failed:`, e.message); }
    }

    // Fallback: imprecise avg-segment-duration method.
    let totalDur = 0, count = 0;
    lines.filter(l => l.startsWith('#EXTINF')).forEach(l => { totalDur += parseFloat(l.split(':')[1]); count++; });
    const avgSeg = count > 0 ? totalDur / count : 5;
    const epochMs = pdtMs - mediaSeq * avgSeg * 1000;
    console.log(`  ${label} (fallback): seq=${mediaSeq} avgSeg=${avgSeg.toFixed(1)}s → streamStart=${new Date(epochMs).toISOString()}`);
    return epochMs;
  } catch (e) {
    console.error(`${label} error:`, e.message);
    return null;
  }
}

// Start PDT tracking for an mpv-hosted live stream. Calibrates mpvPdtEpochMs
// once up front, then refreshes every 60s so long-running streams don't
// accumulate drift from encoder clock skew or PDT re-anchors on the server.
// The refresh reads the *current* currentLiveHlsUrl each cycle so a URL change
// (e.g. /api/watch-on-phone re-resolving the stream) seamlessly retargets
// the calibration instead of stopping the loop.
function startMpvPdtTracking(hlsUrl) {
  stopMpvPdtTracking();
  if (!hlsUrl) return;
  (async () => {
    const epoch = await capturePdtEpoch(hlsUrl, "mpv PDT");
    if (epoch != null) mpvPdtEpochMs = epoch;
  })();
  mpvPdtRefreshInterval = setInterval(async () => {
    const currentUrl = currentLiveHlsUrl;
    if (!currentUrl || !mpvProcess) { stopMpvPdtTracking(); return; }
    const epoch = await capturePdtEpoch(currentUrl, "mpv PDT refresh");
    if (epoch != null) mpvPdtEpochMs = epoch;
  }, 60000);

  // Refresh manifest stats every 10s so the scrubber's DVR window +
  // live-edge PDT stays current. Stream keeps playing smoothly on
  // whichever proxy mpv is on — live (full window, starts near edge)
  // or sub (trimmed window, mpv plays forward and catches up to live
  // via the live-style polling).
  manifestStatsRefresh = setInterval(async () => {
    if (!currentLiveHlsUrl) return;
    try {
      const manifest = await fetchManifest(currentLiveHlsUrl);
      updateManifestStatsFromText(manifest);
    } catch {}
  }, 10_000);
}

let manifestStatsRefresh = null;
// When user seeks back to a sub-proxy window, we anchor "how far behind
// live they wanted to be" + wall-clock at seek time. Used for scrubber
// math during the brief transition before `playbackAnchor` takes over.
let subProxyAnchor = null;
// Unified smooth anchor for phone-sync + scrubber. Captures user's PDT
// at a stable moment; user_pdt advances from there via mpv time-pos
// delta. Stable regardless of mpv cache growth noise.
// Invalidated on mpv path change (new loadfile).
let playbackAnchor = null;

function stopMpvPdtTracking() {
  if (mpvPdtRefreshInterval) { clearInterval(mpvPdtRefreshInterval); mpvPdtRefreshInterval = null; }
  if (manifestStatsRefresh) { clearInterval(manifestStatsRefresh); manifestStatsRefresh = null; }
  mpvPdtEpochMs = 0;
  lastManifestFullDuration = 0;
  lastManifestEdgeEpochMs = 0;
  lastManifestFetchedAt = 0;
}
app.post("/api/mpv-speed", async (req, res) => {
  const { speed } = req.body;
  if (typeof speed !== "number" || speed < 0.5 || speed > 2.0) return res.status(400).json({ error: "Invalid speed" });
  try {
    await mpvCommand(["set_property", "speed", speed]);
    res.json({ ok: true, speed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parse cookies.txt (Netscape format) into a cookie string and extract specific values
function parseCookieFile() {
  try {
    const text = fs.readFileSync(COOKIES_FILE, "utf8");
    const cookies = [];
    const cookieMap = {};
    for (const line of text.split("\n")) {
      if (line.startsWith("#") || !line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length >= 7 && parts[0].includes("youtube.com")) {
        cookies.push(`${parts[5]}=${parts[6]}`);
        cookieMap[parts[5]] = parts[6];
      }
    }
    return { cookieStr: cookies.join("; "), cookieMap };
  } catch { return { cookieStr: "", cookieMap: {} }; }
}

// SAPISIDHASH for YouTube internal API cookie auth
function sapisidHash(sapisid, origin) {
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash("sha1").update(`${ts} ${sapisid} ${origin}`).digest("hex");
  return `SAPISIDHASH ${ts}_${hash}`;
}

// History — YouTube internal API, falls back to local
async function getYouTubeHistory(token) {
  const headers = { "Content-Type": "application/json" };
  // Use OAuth token if available, otherwise use cookies
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  } else {
    const { cookieStr, cookieMap } = parseCookieFile();
    const sapisid = cookieMap["SAPISID"] || cookieMap["__Secure-3PAPISID"];
    if (!sapisid) throw new Error("No SAPISID cookie");
    headers["Cookie"] = cookieStr;
    headers["Authorization"] = sapisidHash(sapisid, "https://www.youtube.com");
    headers["Origin"] = "https://www.youtube.com";
    headers["X-Origin"] = "https://www.youtube.com";
  }
  const res = await fetch("https://www.youtube.com/youtubei/v1/browse", {
    method: "POST",
    headers,
    body: JSON.stringify({
      browseId: "FEhistory",
      context: {
        client: { clientName: "WEB", clientVersion: "2.20240101.00.00" },
      },
    }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json();

  // Extract videos — supports both old videoRenderer and new lockupViewModel
  const videos = [];
  function extract(obj, depth) {
    if (depth > 30 || videos.length >= 30) return;
    if (typeof obj !== "object" || !obj) return;
    if (Array.isArray(obj)) { obj.forEach((i) => extract(i, depth + 1)); return; }
    if (obj.videoRenderer) {
      const vr = obj.videoRenderer;
      videos.push({
        id: vr.videoId,
        title: vr.title?.runs?.[0]?.text || "",
        thumbnail: `https://i.ytimg.com/vi/${vr.videoId}/hq720.jpg`,
        duration: vr.lengthText?.simpleText || "",
        channel: vr.shortBylineText?.runs?.[0]?.text || "",
        views: parseInt((vr.viewCountText?.simpleText?.match(/[\d,]+/) || ["0"])[0].replace(/,/g, "")) || 0,
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
      });
      return;
    }
    if (obj.lockupViewModel) {
      const lv = obj.lockupViewModel;
      const id = lv.contentId || "";
      const meta = lv.metadata?.lockupMetadataViewModel;
      const title = meta?.title?.content || "";
      const channel = meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content?.trim() || "";
      // Extract watch progress from thumbnail overlay
      const lvJson = JSON.stringify(lv);
      const progMatch = lvJson.match(/"startPercent":(\d+)/);
      const pct = progMatch ? parseInt(progMatch[1]) : 0;
      if (id) videos.push({
        id, title, channel,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        duration: "", views: 0,
        url: `https://www.youtube.com/watch?v=${id}`,
        savedPosition: pct > 0 ? pct : 0,
        savedDuration: pct > 0 ? 100 : 0,
      });
      return;
    }
    Object.values(obj).forEach((v) => extract(v, depth + 1));
  }
  extract(data, 0);
  return videos;
}

app.get("/api/history", async (_req, res) => {
  const token = await getAccessToken();

  // Try YouTube internal API (OAuth token or cookies)
  try {
    let videos = await getYouTubeHistory(token);
    if (videos.length) {
      // Enrich with YouTube Data API for missing durations
      const needEnrich = videos.map(v => v.id).filter(Boolean);
      if (needEnrich.length) {
        try {
          const enriched = await enrichVideos(needEnrich, token);
          const enrichMap = Object.fromEntries(enriched.map(v => [v.id, v]));
          for (const v of videos) {
            const e = enrichMap[v.id];
            if (e) {
              v.duration = e.duration || v.duration;
              v.channel = e.channel || v.channel;
              v.channelId = e.channelId || v.channelId;
              v.views = e.views || v.views;
              v.uploadedAt = e.uploadedAt || v.uploadedAt;
              if (e.live) v.live = true;
            }
          }
        } catch {}
      }
      // Merge local progress data (more accurate than YouTube's startPercent)
      const ytUrls = new Set(videos.map(v => v.url));
      for (const v of videos) {
        const h = historyMap.get(v.url);
        if (h?.position > 0 && h?.duration > 0) {
          v.savedPosition = h.position;
          v.savedDuration = h.duration;
        }
      }
      // Re-sort videos that have local timestamps to top, by recency
      // (phone-only mode saves timestamps locally but doesn't update YouTube's history)
      const withTs = [];
      const withoutTs = [];
      for (const v of videos) {
        const ts = historyMap.get(v.url)?.timestamp;
        if (ts) { v._localTs = ts; withTs.push(v); } else { withoutTs.push(v); }
      }
      withTs.sort((a, b) => b._localTs - a._localTs);
      withTs.forEach(v => delete v._localTs);
      videos = [...withTs, ...withoutTs];
      // Deduplicate by URL
      const seenUrls = new Set();
      videos = videos.filter(v => { if (seenUrls.has(v.url)) return false; seenUrls.add(v.url); return true; });
      // Merge local-only history (Rumble, phone-only YouTube, etc) by timestamp
      const now = Date.now();
      const ytTimestamps = videos.map((v, i) => historyMap.get(v.url)?.timestamp || (now - i * 60000));
      const allUrls = new Set(videos.map(v => v.url));
      const nonYt = history.filter(h => !allUrls.has(h.url));
      for (const h of nonYt) {
        const ts = h.timestamp || 0;
        let insertIdx = videos.length;
        for (let i = 0; i < videos.length; i++) {
          if (ytTimestamps[i] < ts) { insertIdx = i; break; }
        }
        const ytMatch = h.url.match(/v=([\w-]+)/);
        videos.splice(insertIdx, 0, {
          id: ytMatch ? ytMatch[1] : h.url,
          title: h.title || h.url,
          thumbnail: h.thumbnail || (ytMatch ? `https://i.ytimg.com/vi/${ytMatch[1]}/hqdefault.jpg` : ""),
          duration: "", channel: h.channel || "", views: 0, url: h.url,
          savedPosition: h.position || 0, savedDuration: h.duration || 0,
          platform: h.url.includes("rumble.com") ? "rumble" : undefined,
        });
        ytTimestamps.splice(insertIdx, 0, ts);
      }
      return res.json(videos);
    }
  } catch (err) {
    console.error("YouTube history API failed:", err.message);
  }

  // Fall back to local history, enriched with API data
  const localVideos = history.map((h) => {
    const m = h.url.match(/v=([\w-]+)/);
    return {
      id: m ? m[1] : h.url,
      title: h.title || h.url,
      thumbnail: h.thumbnail || (m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : ""),
      duration: "",
      channel: h.channel || "",
      views: 0,
      url: h.url,
      savedPosition: h.position || 0,
      savedDuration: h.duration || 0,
    };
  });
  try {
    const ids = localVideos.map(v => v.id).filter(Boolean);
    if (ids.length) {
      const enriched = await enrichVideos(ids, token);
      const enrichMap = Object.fromEntries(enriched.map(v => [v.id, v]));
      return res.json(localVideos.map(v => {
        const e = enrichMap[v.id];
        if (!e) return v;
        return { ...v, channel: e.channel || v.channel, channelId: e.channelId, duration: e.duration || v.duration, views: e.views || v.views, uploadedAt: e.uploadedAt || "" };
      }));
    }
  } catch {}
  res.json(localVideos);
});

// Check live status for a video
app.get("/api/live-status", async (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.json({});
  try {

    const result = {};
    const checks = ids.split(",").slice(0, 10).map(async (id) => {
      try {
        const v = await YouTube.getVideo(`https://www.youtube.com/watch?v=${id}`);
        if (v?.live && !v?.duration) result[id] = true;
      } catch {}
    });
    await Promise.all(checks);
    res.json(result);
  } catch {
    res.json({});
  }
});

// Safety interlock: only the iPhone hardware volume button intercept
// is gated — not the slider or mute toggle. The hardware-button path
// is what misbehaves when the active output is MacBook speakers or
// LG display audio (some interaction with the KVO observer vs the
// system's own handling for those outputs creates feedback loops).
// The phone slider and secret-menu mute are explicit user actions
// and should always work.
let _cachedAudioOut = null;
let _cachedAudioOutAt = 0;
async function isProtectedAudioOutput() {
  try {
    const now = Date.now();
    if (!_cachedAudioOut || (now - _cachedAudioOutAt) > 3000) {
      _cachedAudioOut = (await execP("SwitchAudioSource -c -t output")).stdout.trim();
      _cachedAudioOutAt = now;
    }
    const name = (_cachedAudioOut || "").toLowerCase();
    return name.includes("macbook") || name.includes("lg ");
  } catch {
    // On any error, err on the safe side: block the change.
    return true;
  }
}

// Watch on phone — pause mpv, return YouTube URL at current timestamp
// Volume control
app.get("/api/volume", async (_req, res) => {
  try {
    const [volOut, muteOut] = await Promise.all([
      execP(`osascript -e 'output volume of (get volume settings)'`),
      execP(`osascript -e 'output muted of (get volume settings)'`),
    ]);
    res.json({ volume: parseInt(volOut.stdout.trim()), muted: muteOut.stdout.trim() === "true" });
  } catch {
    res.json({ volume: 50, muted: false });
  }
});

// Mac volume cache — avoids round-tripping osascript on every button press
let _cachedVolume = null;
let _pendingVolumeTimer = null;

app.post("/api/volume", async (req, res) => {
  const vol = parseInt(req.body.volume);
  if (isNaN(vol) || vol < 0 || vol > 100) return res.status(400).json({ error: "Invalid volume" });
  try {
    await execP(`osascript -e 'set volume output volume ${vol}'`);
    _cachedVolume = vol;
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Volume failed" });
  }
});

// Relative bump — used by phone hardware volume buttons.
app.post("/api/volume-bump", async (req, res) => {
  const delta = parseInt(req.body.delta);
  if (isNaN(delta)) return res.status(400).json({ error: "Invalid delta" });
  if (await isProtectedAudioOutput()) {
    return res.json({ ok: false, skipped: true, reason: "protected-output", output: _cachedAudioOut });
  }
  try {
    if (_cachedVolume == null) {
      _cachedVolume = parseInt((await execP(`osascript -e 'output volume of (get volume settings)'`)).stdout.trim()) || 0;
    }
    _cachedVolume = Math.max(0, Math.min(100, _cachedVolume + delta));
    // Respond immediately with the expected value — the osascript call is
    // debounced so rapid presses only fire one system call at the end.
    const next = _cachedVolume;
    res.json({ ok: true, volume: next });
    if (_pendingVolumeTimer) clearTimeout(_pendingVolumeTimer);
    _pendingVolumeTimer = setTimeout(() => {
      _pendingVolumeTimer = null;
      execP(`osascript -e 'set volume output volume ${next}'`).catch(() => {});
    }, 30);
  } catch {
    res.status(500).json({ error: "Volume failed" });
  }
});


// Refresh cookies from Firefox (requires Mac to be unlocked)
app.post("/api/refresh-cookies", async (_req, res) => {
  const ok = await exportCookies();
  res.json({ ok });
});

// Mute toggle
app.get("/api/volume-status", async (_req, res) => {
  try {
    const [muteOut, volOut] = await Promise.all([
      execP(`osascript -e 'output muted of (get volume settings)'`),
      execP(`osascript -e 'output volume of (get volume settings)'`),
    ]);
    res.json({ muted: muteOut.stdout.trim() === "true", volume: parseInt(volOut.stdout.trim()) || 0 });
  } catch { res.json({ muted: false, volume: 50 }); }
});

app.post("/api/mute", async (_req, res) => {
  try {
    const { stdout } = await execP(`osascript -e 'output muted of (get volume settings)'`);
    const isMuted = stdout.trim() === "true";
    await execP(`osascript -e 'set volume output muted ${isMuted ? "false" : "true"}'`);
    res.json({ ok: true, muted: !isMuted });
  } catch {
    res.status(500).json({ error: "Mute failed" });
  }
});

// Toggle mpv video visibility (audio-only mode)
app.post("/api/mpv-video", async (req, res) => {
  const { hidden } = req.body;
  try {
    await mpvCommand(["set_property", "vid", hidden ? "no" : "auto"]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// Phone sync debug — stores latest data from phone, readable via GET
let _phoneSyncDebug = null;
app.post("/api/phone-debug", (req, res) => { _phoneSyncDebug = { ...req.body, ts: Date.now() }; res.json({ ok: true }); });
app.get("/api/phone-debug", (_req, res) => { res.json(_phoneSyncDebug || {}); });

app.get("/api/phone-sync-target", async (_req, res) => {
  if (activePlayer === "mpv" && mpvProcess) {
    try {
      const p = await mpvCommand(["get_property", "time-pos"]);
      // Field is named `vlcTime` historically; kept for client compat.
      if (p?.data) return res.json({ vlcTime: p.data, serverTs: Date.now() });
    } catch {}
  }
  res.json({});
});

// fMP4 relay — ffmpeg reads stream source, outputs fragmented MP4 for phone
let phoneFmp4Process = null;
let _phoneVodUrls = null; // { video, audio } for DASH remux

app.get("/api/phone-live-stream", async (_req, res) => {
  // Stream directly from ffmpeg with Content-Length for Safari compatibility
  let streamUrl = currentLiveHlsUrl;
  if (!streamUrl && nowPlaying) {
    try {
      const { stdout } = await execFileP("yt-dlp", ["--cookies", COOKIES_FILE, "-f", "95/94/93/22/18/best[height<=720]", "--get-url", nowPlaying], { timeout: 15000 });
      streamUrl = stdout.trim().split("\n")[0];
    } catch {}
  }
  if (!streamUrl) return res.status(400).send("no stream");
  if (phoneFmp4Process) { try { phoneFmp4Process.kill("SIGKILL"); } catch {} }
  // Safari requires Content-Length to play video inline
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", 500 * 1024 * 1024);
  const ffArgs = [];
  const isLive = streamUrl.includes(".m3u8") || streamUrl.includes("/live/1");
  if (!isLive) {
    if (activePlayer === "mpv") {
      try { const p = await mpvCommand(["get_property", "time-pos"]); if (p?.data > 5) ffArgs.push("-ss", String(Math.floor(p.data - 3))); } catch {}
    }
  }
  ffArgs.push("-i", streamUrl, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1");
  const ff = spawn("ffmpeg", ffArgs, { stdio: ["ignore", "pipe", "ignore"] });
  phoneFmp4Process = ff;
  ff.stdout.pipe(res);
  ff.on("exit", () => { if (phoneFmp4Process === ff) phoneFmp4Process = null; });
  res.on("close", () => { try { ff.kill("SIGKILL"); } catch {} });
});

// Watch on phone — get stream URL for phone playback
let phoneActive = false; // phone sync is active — don't show mpv window on unpause
function killPhoneStream() {
  if (phoneFmp4Process) { try { phoneFmp4Process.kill("SIGKILL"); } catch {} phoneFmp4Process = null; }
}

app.post("/api/watch-on-phone", async (_req, res) => {
  if (!nowPlaying) return res.status(400).json({ error: "Nothing playing" });
  try {
    let seconds = 0;
    const pos = await mpvCommand(["get_property", "time-pos"]);
    seconds = Math.floor(pos?.data || 0);
    const m = nowPlaying.match(/v=([\w-]+)/);
    const videoId = m ? m[1] : "";

    if (activePlayer === "mpv") {
      phoneActive = true;
      // Hide mpv window when playing on phone (don't use vid=no, it can drop audio)
      try { execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to false'`, { stdio: "ignore" }); } catch {}
    }

    // Live detection: try mpv's file-format first, fall back to yt-dlp
    const fmt = await mpvCommand(["get_property", "file-format"]).catch(() => null);
    let isLiveStream = (fmt?.data || "").includes("hls");
    let hlsUrl = null;
    if (isLiveStream) {
      try {
        const sp = await mpvCommand(["get_property", "stream-path"]);
        const edl = sp?.data || "";
        const hlsMatch = edl.match(/(https:\/\/manifest\.googlevideo\.com\/[^\s;]+)/);
        if (hlsMatch) hlsUrl = hlsMatch[1];
      } catch {}
    }
    // Fallback: check via yt-dlp — only if mpv's file-format already
    // suggested HLS. On a plain VOD (file-format="mov,mp4,..."),
    // isLiveStream is definitively false and running a second yt-dlp
    // call here just to confirm burns ~5-8s of user-visible latency
    // before we even start resolving the VOD formats below.
    if (isLiveStream && !hlsUrl) {
      try {
        const { stdout: ltest } = await execFileP("yt-dlp", ["--cookies", COOKIES_FILE, "--print", "is_live", "--get-url", "-f", "best", nowPlaying], { timeout: 15000 });
        const lines = ltest.trim().split("\n");
        if (lines.some(l => l.trim() === "True")) {
          isLiveStream = true;
          hlsUrl = lines.find(l => l.startsWith("http"));
        }
      } catch {}
    }
    if (isLiveStream && hlsUrl) {
      currentLiveHlsUrl = hlsUrl;
      // Phone handing off from a fresh URL — restart mpv PDT tracking so
      // the refresh loop doesn't stop itself due to the URL mismatch.
      startMpvPdtTracking(hlsUrl);
      phoneActive = true;
      return res.json({
        streamUrl: hlsUrl,
        proxyUrl: `/api/phone-hls?t=${Date.now()}`,
        seconds, videoId, isLive: true
      });
    }

    // VOD — try DASH 1080p first (native AVPlayer composes video+audio),
    // fall back to progressive 22 (720p + AAC in one URL) for web and
    // for reliability with seeks.
    // Prefer progressive format 22 — single URL that AVPlayer loads
    // instantly via HTTP Range, no manifest probing or composition
    // building. In sync mode mpv is the primary screen at full quality,
    // so 720p on the phone is fine. The DASH 1080p composition path
    // (137+140) takes ~8s to load because AVURLAsset has to probe both
    // DASH manifests serially before AVPlayer can even start, and the
    // quality gain isn't visible when mpv is what the user's actually
    // watching.
    const { stdout } = await execFileP(
      "yt-dlp",
      ["--cookies", COOKIES_FILE, "-f", "22/best[ext=mp4]/137+140/136+140/135+140", "--get-url", nowPlaying],
      { timeout: 15000 }
    );
    const urls = stdout.trim().split("\n").filter(l => l.startsWith("http"));
    if (urls.length >= 2) {
      res.json({
        streamUrl: urls[0],
        videoUrl: urls[0],
        audioUrl: urls[1],
        seconds,
        videoId,
      });
    } else {
      res.json({ streamUrl: urls[0], seconds, videoId });
    }
  } catch (err) {
    console.error("Watch on phone error:", err.message);
    try {
      const m = nowPlaying.match(/v=([\w-]+)/);
      const pos = await mpvCommand(["get_property", "time-pos"]).catch(() => ({ data: 0 }));
      const s = Math.floor(pos?.data || 0);
      res.json({ youtubeUrl: `https://youtu.be/${m?.[1]}?t=${s}`, seconds: s });
    } catch {
      res.status(500).json({ error: "Failed" });
    }
  }
});

// Phone-only playback — no mpv, just get stream URL for a given video
// Prepare existing mpv for phone-only mode: mute, hide, load URL if different
let _phoneMpvLock = Promise.resolve();
function preparePhoneOnlyMpv(url, resumePos) {
  _phoneMpvLock = _phoneMpvLock.then(() => _preparePhoneOnlyMpvImpl(url, resumePos)).catch(e => console.error("[phone-only] mpv lock error:", e.message));
  return _phoneMpvLock;
}
async function _preparePhoneOnlyMpvImpl(url, resumePos) {
  phoneActive = true;
  // If our tracking was lost (e.g. server restart before reconnect finished) but an mpv
  // is actually running and its IPC socket responds, adopt it instead of spawning a duplicate.
  if (activePlayer !== "mpv" || !mpvProcess) {
    try {
      const ping = await mpvCommand(["get_property", "path"]);
      if (ping?.data) {
        mpvProcess = { kill: () => { try { execSync("pkill -x mpv", { stdio: "ignore" }); } catch {} } };
        activePlayer = "mpv";
        const pathUrl = ping.data;
        const m = pathUrl.match(/v=([\w-]+)/);
        nowPlaying = m ? `https://www.youtube.com/watch?v=${m[1]}` : pathUrl;
        console.log(`[phone-only] adopted existing mpv (${nowPlaying.substring(0, 60)})`);
      }
    } catch {}
  }
  if (activePlayer !== "mpv" || !mpvProcess) {
    // No mpv running — spawn one hidden+muted
    try { fs.unlinkSync("/tmp/mpv-socket"); } catch {}
    const mpvArgs = [
      `--input-ipc-server=/tmp/mpv-socket`,
      `--ytdl-raw-options=cookies=${COOKIES_FILE}`,
      `--hwdec=auto-safe`, `--keep-open`, `--cache=yes`, `--autosync=30`,
      `--mute=yes`,
      url,
    ];
    if (resumePos > 0) mpvArgs.push(`--start=${Math.floor(resumePos)}`);
    mpvProcess = spawn("mpv", mpvArgs, { stdio: "ignore" });
    activePlayer = "mpv";
    nowPlaying = url;
    windowMode = "floating";
    setTimeout(() => {
      try { execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to false'`, { stdio: "ignore" }); } catch {}
    }, 3000);
    console.log(`[phone-only] mpv spawned hidden+muted`);
    return;
  }
  try {
    await mpvCommand(["set_property", "mute", true]);
    execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to false'`, { stdio: "ignore" });
    if (nowPlaying !== url) {
      await mpvCommand(["loadfile", url, "replace"]);
      nowPlaying = url;
      if (resumePos > 0) {
        setTimeout(async () => { try { await mpvCommand(["set_property", "time-pos", resumePos]); } catch {} }, 2000);
      }
    }
    console.log(`[phone-only] mpv muted+hidden`);
  } catch (e) {
    console.error("[phone-only] mpv prep error:", e.message);
  }
}

// Resume phone-only mode (re-mute mpv, keep playing for position tracking)
app.post("/api/phone-only-resume", async (_req, res) => {
  if (activePlayer === "mpv" && mpvProcess) {
    try {
      await mpvCommand(["set_property", "mute", true]);
      execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to false'`, { stdio: "ignore" });
    } catch {}
  }
  phoneActive = true;
  res.json({ ok: true });
});

let _phoneOnlyToken = 0;
app.post("/api/phone-only", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "No URL" });
  const token = ++_phoneOnlyToken;
  const isCurrent = () => token === _phoneOnlyToken;
  try {
    const m = url.match(/v=([\w-]+)/);
    const videoId = m ? m[1] : "";

    // Progressive MP4 (format 22 = 720p + 128kbps AAC): single URL with
    // working ranged seeks. DASH 1080p looks nicer but YouTube caps the
    // byte-range window on DASH URLs so seeks past ~a few minutes fail.
    const { stdout } = await execFileP("yt-dlp", [
      "--cookies", COOKIES_FILE,
      "-f", "22/best[ext=mp4][height<=720]/best",
      "--get-url", "--print", "is_live", "--print", "duration", "--print", "title", "--print", "channel", "--print", "thumbnail", url,
    ], { timeout: 15000 });
    if (!isCurrent()) return res.status(409).json({ error: "Superseded" });
    const lines = stdout.trim().split("\n");
    const isLive = lines.some(l => l.trim() === "True");
    const durLine = lines.find(l => /^\d+(\.\d+)?$/.test(l.trim()));
    const duration = durLine ? parseFloat(durLine) : 0;
    // yt-dlp prints in order: is_live, duration, title, channel, thumbnail, then --get-url URLs.
    // Detect thumbnail by image extension (or known image hosts) so Rumble (whose thumbs live on
    // the same CDN as the stream) doesn't leak its thumbnail into the stream URL list.
    const isImageUrl = (u) => /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(u) || u.includes("ytimg.com");
    const httpLines = lines.filter(l => l.startsWith("http"));
    const thumbnail = httpLines.find(isImageUrl) || "";
    const urls = httpLines.filter(l => !isImageUrl(l));
    // Title and channel are the non-http non-numeric lines (excluding True/False/NA)
    const metaLines = lines.filter(l => !l.startsWith("http") && l.trim() !== "True" && l.trim() !== "False" && !/^\d+(\.\d+)?$/.test(l.trim()) && l.trim() !== "NA");
    const title = metaLines[0] || "";
    const channel = metaLines[1] || "";
    // Seed historyMap so WS sync broadcasts title/channel/duration
    // (duration fallback is important because mpv returns null while loading)
    if (title) {
      const existing = historyMap.get(url) || {};
      historyMap.set(url, { ...existing, title, channel, thumbnail, url, duration: duration || existing.duration });
    }
    // Use mpv's current position if playing, otherwise fall back to history
    let seconds = 0;
    if (!isLive && activePlayer === "mpv" && mpvProcess) {
      try {
        const pos = await mpvCommand(["get_property", "time-pos"]);
        seconds = Math.floor(pos?.data || 0);
      } catch {}
    }
    if (!seconds && !isLive) {
      const savedEntry = historyMap.get(url);
      seconds = savedEntry?.position || 0;
    }

    console.log(`[phone-only] mpv pos=${seconds}, url match=${nowPlaying === url}`);
    // Mute+hide+pause mpv — phone is the active player now (awaited so concurrent calls queue)
    await preparePhoneOnlyMpv(url, seconds);
    if (!isCurrent()) return res.status(409).json({ error: "Superseded" });
    // Record in history (sync mode's /api/play does this — phone-only must too)
    addToHistory(url, title, channel, thumbnail);
    startProgressTracking(url);

    if (urls.length >= 2 && !isLive) {
      // DASH streams — return both URLs. Native AVPlayer composes them
      // client-side (AVMutableComposition) for 1080p + 128kbps AAC without
      // any server-side remuxing. Web fallback: use first URL (video-only;
      // non-native should not hit this since we only ask for DASH on native).
      res.json({
        streamUrl: urls[0],
        videoUrl: urls[0],
        audioUrl: urls[1],
        seconds, videoId, isLive: false, duration,
      });
    } else if (isLive && urls[0]) {
      // Live — YouTube needs the proxy (PDT parsing, cookie-authed segments on googlevideo.com).
      // Other hosts (e.g. Rumble) serve standard HLS with CORS enabled — return the direct URL
      // so Safari plays it natively.
      const isYouTube = urls[0].includes("googlevideo.com") || urls[0].includes("youtube.com");
      if (isYouTube) {
        currentLiveHlsUrl = urls[0];
        res.json({ streamUrl: `/api/phone-hls?t=${Date.now()}`, seconds, videoId, isLive: true, duration });
      } else {
        res.json({ streamUrl: urls[0], seconds, videoId, isLive: true, duration });
      }
    } else {
      // Progressive VOD — direct URL
      res.json({ streamUrl: urls[0] || "", seconds, videoId, isLive, duration });
    }
  } catch (err) {
    console.error("Phone-only error:", err.message);
    res.status(500).json({ error: "Failed to get stream URL" });
  }
});

// Save progress from phone-only playback
app.post("/api/phone-progress", (req, res) => {
  const { url, position, duration, title, channel, thumbnail } = req.body;
  if (!url || position == null) return res.status(400).json({ error: "Missing url/position" });
  console.log(`[phone-progress] ${title?.slice(0,30)} pos=${Math.floor(position)} dur=${Math.floor(duration||0)}`);
  addToHistory(url, title || "", channel || "", thumbnail || "");
  updateHistoryProgress(url, position, duration || 0);
  res.json({ ok: true });
});

// HLS packaging for phone-only 1080p DASH streams
let _phoneHlsProc = null;
let _phoneHlsReady = false;

function cleanPhoneHls() {
  try {
    const files = fs.readdirSync("/tmp").filter(f => f.startsWith("phone-hls"));
    files.forEach(f => {
      const p = `/tmp/${f}`;
      try {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) fs.rmSync(p, { recursive: true });
        else fs.unlinkSync(p);
      } catch {}
    });
  } catch {}
}

async function preparePhoneHls() {
  // Wait for previous ffmpeg to fully exit before cleaning files it might still hold
  if (_phoneHlsProc) {
    const prev = _phoneHlsProc;
    await new Promise((resolve) => {
      prev.once("exit", resolve);
      try { prev.kill("SIGKILL"); } catch { resolve(); }
      // Hard timeout to avoid hanging
      setTimeout(resolve, 2000);
    });
  }
  _phoneHlsReady = false;
  cleanPhoneHls();
  const { video, audio } = _phoneVodUrls;
  console.log(`[phone-hls] starting ffmpeg (full VOD)`);
  const ff = spawn("ffmpeg", [
    "-y", "-i", video, "-i", audio,
    "-c:v", "copy", "-c:a", "copy",
    "-f", "hls", "-hls_time", "6", "-hls_list_size", "0",
    "-hls_playlist_type", "vod",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", "/tmp/phone-hls-%05d.ts",
    "/tmp/phone-hls.m3u8",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  _phoneHlsProc = ff;
  let stderrBuf = "";
  ff.stderr.on("data", (d) => { stderrBuf = d.toString().slice(-200); });
  return new Promise((resolve) => {
    ff.on("exit", (code) => {
      console.log(`[phone-hls] ffmpeg exited code=${code}`);
      if (code !== 0) console.log(`[phone-hls] stderr: ${stderrBuf}`);
      _phoneHlsProc = null;
      _phoneHlsReady = fs.existsSync("/tmp/phone-hls.m3u8");
      resolve(_phoneHlsReady);
    });
  });
}

// Serve HLS playlist and segments
app.get("/phone-hls/:file", async (req, res) => {
  const filePath = `/tmp/${req.params.file}`;
  if (!fs.existsSync(filePath)) {
    const start = Date.now();
    while (!fs.existsSync(filePath) && Date.now() - start < 30000) {
      await new Promise(r => setTimeout(r, 300));
    }
    if (!fs.existsSync(filePath)) return res.status(404).end();
  }
  const isMaster = req.params.file.endsWith('.m3u8');
  res.setHeader("Content-Type", isMaster ? "application/vnd.apple.mpegurl" : "video/mp2t");
  res.setHeader("Cache-Control", isMaster ? "no-store" : "public, max-age=3600");
  fs.createReadStream(filePath).pipe(res);
});

// VOD DASH remux: merge separate 720p video + audio into fragmented MP4
app.get("/api/phone-vod-stream", (req, res) => {
  if (!_phoneVodUrls) return res.status(400).json({ error: "No VOD URLs" });
  const { video, audio } = _phoneVodUrls;
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "no-store");
  const ff = spawn("ffmpeg", [
    "-i", video, "-i", audio,
    "-c", "copy", "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "pipe:1"
  ], { stdio: ["ignore", "pipe", "ignore"] });
  ff.stdout.pipe(res);
  res.on("close", () => { ff.kill(); });
});

// Phone (or any client) pushing its playback position into our history map.
// Used by the native AVPlayer in phone-only mode where mpv is muted+hidden
// so the server's progress poll isn't authoritative.
app.post("/api/save-progress", (req, res) => {
  const { url, position, duration } = req.body || {};
  if (!url || typeof position !== "number" || typeof duration !== "number") {
    return res.status(400).json({ error: "url, position, duration required" });
  }
  if (position < 0 || duration <= 0 || position > duration * 1.05) {
    return res.status(400).json({ error: "invalid position/duration" });
  }
  updateHistoryProgress(url, position, duration);
  res.json({ ok: true });
});

app.post("/api/stop-phone-stream", async (_req, res) => {
  killPhoneStream();
  phoneActive = false;
  if (activePlayer === "mpv") {
    // Restore mpv: unmute, show window (each step independent so one failure doesn't block rest)
    try { await mpvCommand(["set_property", "mute", false]); } catch {}
    try { await mpvCommand(["set_property", "pause", false]); } catch {}
    try { execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to true'`, { stdio: "ignore" }); } catch {}
    try {
      if (windowMode === "maximize") {
        const wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
        if (wid) {
          execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" });
          execSync(`aerospace fullscreen --no-outer-gaps on --window-id ${wid}`, { stdio: "ignore" });
        }
      }
    } catch {}
  }
  res.json({ ok: true });
});

// Comments — uses yt-dlp (no quota)
// Live chat — fetches messages via YouTube API
app.get("/api/livechat", async (req, res) => {
  const { videoId, pageToken } = req.query;
  if (!videoId) return res.json({ messages: [] });
  try {
    const token = await getAccessToken();
    // Get live chat ID from video
    const vidData = await ytFetch("videos", { part: "liveStreamingDetails", id: videoId }, token);
    const chatId = vidData.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (!chatId) return res.json({ messages: [], error: "No active chat" });

    // Fetch chat messages
    const params = { part: "snippet,authorDetails", liveChatId: chatId, maxResults: 200 };
    if (pageToken) params.pageToken = pageToken;
    const chatData = await ytFetch("liveChat/messages", params, token);
    const messages = (chatData.items || []).map(m => ({
      author: m.authorDetails?.displayName || "",
      text: m.snippet?.displayMessage || "",
      isMod: m.authorDetails?.isChatModerator || false,
      isOwner: m.authorDetails?.isChatOwner || false,
      time: m.snippet?.publishedAt,
    }));
    res.json({ messages, nextPageToken: chatData.nextPageToken, pollingMs: chatData.pollingIntervalMillis || 5000 });
  } catch (err) {
    console.error("Live chat error:", err.message);
    res.json({ messages: [], error: err.message });
  }
});

// Storyboard (seek preview thumbnails) — parsed from yt-dlp
const _storyboardCache = new Map(); // videoId -> { url, cols, rows, interval } — capped at 50
const STORYBOARD_CACHE_MAX = 50;
app.get("/api/storyboard", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.json({});
  if (_storyboardCache.has(videoId)) return res.json(_storyboardCache.get(videoId));
  try {
    const { stdout } = await execFileP("yt-dlp", [
      "--cookies", COOKIES_FILE, "-j", "--no-download", "--no-warnings",
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 15000 });
    const info = JSON.parse(stdout);
    // yt-dlp provides storyboard in formats as sb0, sb1, sb2, etc.
    // Or in the 'storyboards' field. Look for the highest quality storyboard format.
    const sbFormat = (info.formats || [])
      .filter(f => f.format_id?.startsWith("sb") && f.columns && f.rows)
      .sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    const chapters = (info.chapters || []).map(c => ({ start: c.start_time, end: c.end_time, title: c.title }));
    const result = { chapters };
    if (sbFormat) {
      result.url = (sbFormat.url || sbFormat.fragment_base_url || "").replace(/M\d+\.jpg/, "M$M.jpg");
      result.cols = sbFormat.columns;
      result.rows = sbFormat.rows;
      result.width = sbFormat.width ? Math.floor(sbFormat.width / sbFormat.columns) : 160;
      result.height = sbFormat.height ? Math.floor(sbFormat.height / sbFormat.rows) : 90;
      // Fragment duration is per PAGE (cols*rows frames), divide to get per-frame interval
      const pageDur = sbFormat.fragments?.[0]?.duration || 2;
      result.interval = pageDur / (sbFormat.columns * sbFormat.rows);
    }
    if (_storyboardCache.size >= STORYBOARD_CACHE_MAX) {
      const oldest = _storyboardCache.keys().next().value;
      _storyboardCache.delete(oldest);
    }
    _storyboardCache.set(videoId, result);
    res.json(result);
  } catch (err) {
    console.error("Storyboard error:", err.message);
    res.json({});
  }
});

app.get("/api/comments", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.json([]);

  try {
    const { stdout } = await execFileP(
      "yt-dlp", [
        "--cookies", COOKIES_FILE,
        "--extractor-args", "youtube:max_comments=50,all,0,0;comment_sort=top",
        "--write-comments", "--skip-download", "--dump-json",
        "--no-warnings",
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: 20000, maxBuffer: 5 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout);
    // Top-level comments only, sorted by likes desc as a safety net
    const comments = (data.comments || [])
      .filter((c) => !c.parent || c.parent === "root")
      .map((c) => ({
        author: c.author || "Unknown",
        text: c.text || "",
        likes: c.like_count || 0,
        publishedAt: c.timestamp ? timeAgo(new Date(c.timestamp * 1000).toISOString()) : "",
      }))
      .sort((a, b) => (b.likes || 0) - (a.likes || 0));
    res.json(comments);
  } catch (err) {
    console.error("Comments error:", err.message);
    res.json([]);
  }
});

// Idempotent pause/resume (for lock screen widget — avoids toggle race conditions)
app.post("/api/pause", async (_req, res) => {
  try { await mpvCommand(["set_property", "pause", true]); } catch {}
  _lastPolledPaused = true;
  if (windowMode !== "fullscreen") {
    try { execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to false'`, { stdio: "ignore" }); } catch {}
  }
  res.json({ ok: true, paused: true });
});

app.post("/api/resume", async (_req, res) => {
  try { await mpvCommand(["set_property", "pause", false]); } catch {}
  _lastPolledPaused = false;
  if (windowMode !== "fullscreen" && !phoneActive) {
    try {
      execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to true'`, { stdio: "ignore" });
      if (windowMode === "maximize") {
        const wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
        if (wid) { try { execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" }); execSync(`aerospace fullscreen --no-outer-gaps on`, { stdio: "ignore" }); } catch {} }
      }
    } catch {}
  }
  res.json({ ok: true, paused: false });
});

// Play/pause (toggle)
app.post("/api/playpause", async (_req, res) => {
  try {
    await mpvCommand(["cycle", "pause"]);
    // Small delay to let mpv apply the state change before reading it back
    await new Promise(r => setTimeout(r, 50));
    const state = await mpvCommand(["get_property", "pause"]);
    const paused = !!state?.data;
    // Always ensure unmuted when playing on desktop
    if (!paused && !phoneActive) {
      try { await mpvCommand(["set_property", "mute", false]); } catch {}
    }
    _lastPolledPaused = paused; // sync so poll loop doesn't double-trigger
    // Hide/show window when pausing (any mode except native fullscreen)
    if (windowMode !== "fullscreen") {
      try {
        if (paused) {
          execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to false'`, { stdio: "ignore" });
        } else if (!phoneActive) {
          execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to true'`, { stdio: "ignore" });
          execSync(`osascript -e 'tell application "System Events" to set frontmost of process "mpv" to true'`, { stdio: "ignore" });
          if (windowMode === "maximize") {
            const wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
            if (wid) {
              execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" });
              execSync(`aerospace fullscreen --no-outer-gaps on --window-id ${wid}`, { stdio: "ignore" });
            }
          }
        }
      } catch (e) { console.error("  Hide/show mpv failed:", e.message); }
    }
    res.json({ ok: true, paused });
  } catch {
    res.status(500).json({ error: "Play/pause failed" });
  }
});

// Move mpv between monitors via AppleScript
// Gets screen info dynamically so it works at any resolution
let _screenInfoCache = null;
let _screenInfoAt = 0;
async function getScreenInfo() {
  if (_screenInfoCache && Date.now() - _screenInfoAt < 3000) return _screenInfoCache;
  const { stdout: out } = await execFileP("python3", ["-c", `
import subprocess, json
r = subprocess.run(['system_profiler', 'SPDisplaysDataType', '-json'], capture_output=True, text=True)
data = json.loads(r.stdout)
screens = []
for gpu in data.get('SPDisplaysDataType', []):
    for d in gpu.get('spdisplays_ndrvs', []):
        res = d.get('_spdisplays_resolution', '')
        parts = res.split(' x ')
        w = int(parts[0])
        h = int(parts[1].split(' @')[0].strip())
        main = 'yes' in d.get('spdisplays_main', '')
        screens.append({'name': d.get('_name',''), 'w': w, 'h': h, 'main': main})
print(json.dumps(screens))
`], { timeout: 5000 });
  _screenInfoCache = JSON.parse(out.trim());
  _screenInfoAt = Date.now();
  return _screenInfoCache;
}

// Move mpv between monitors — uses aerospace to move, then re-applies current window mode
app.post("/api/move-monitor", async (req, res) => {
  if (windowLock) return res.json({ ok: true, skipped: true });
  windowLock = true;
  const { target } = req.body;
  try {
    const wid = execSync(`aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1`, { encoding: "utf8" }).trim();
    if (!wid) return res.status(400).json({ error: "No mpv window" });

    const screens = getScreenOrigins();
    const screenIdx = target === "laptop" ? screens.findIndex(s => s.isLaptop) : screens.findIndex(s => s.isMain);
    const idx = screenIdx >= 0 ? screenIdx : 0;

    const targetWs = target === "laptop" ? "8" : "1";

    // Exit all fullscreen modes
    try { execSync(`aerospace fullscreen off --window-id ${wid}`, { stdio: "ignore" }); } catch {}
    await mpvCommand(["set_property", "fullscreen", false]).catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    // Move aerospace window to target workspace, then focus it
    try {
      execSync(`aerospace move-node-to-workspace --window-id ${wid} ${targetWs}`, { stdio: "ignore" });
      execSync(`aerospace workspace ${targetWs}`, { stdio: "ignore" });
    } catch {}
    await new Promise(r => setTimeout(r, 200));

    // Bounce through fullscreen on target screen to physically move mpv
    await mpvCommand(["set_property", "fs-screen", idx]);
    await mpvCommand(["set_property", "fullscreen", true]);
    if (windowMode !== "fullscreen") {
      await new Promise(r => setTimeout(r, 300));
      await mpvCommand(["set_property", "fullscreen", false]);
      await new Promise(r => setTimeout(r, 300));
      if (windowMode === "maximize") {
        execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" });
        execSync(`aerospace fullscreen --no-outer-gaps on --window-id ${wid}`, { stdio: "ignore" });
      } else {
        try { await mpvCommand(["set_property", "ontop", true]); } catch {}
      }
    }
    currentMonitor = target;
    res.json({ ok: true });
  } catch (err) {
    console.error("Move failed:", err.message);
    res.status(500).json({ error: "Move failed" });
  } finally {
    windowLock = false;
  }
});

// Get screen origins from displayplacer
let _screenOriginsCache = null;
let _screenOriginsAt = 0;
function getScreenOrigins() {
  if (_screenOriginsCache && Date.now() - _screenOriginsAt < 3000) return _screenOriginsCache;
  try {
    const out = execSync("displayplacer list", { encoding: "utf8" });
    const screens = [];
    const blocks = out.split("Persistent screen id:");
    for (const block of blocks) {
      if (!block.trim()) continue;
      const typeMatch = block.match(/Type:\s*(.+)/);
      const resMatch = block.match(/Resolution:\s*(\d+)x(\d+)/);
      const originMatch = block.match(/Origin:\s*\((-?\d+),(-?\d+)\)/);
      if (resMatch && originMatch) {
        screens.push({
          isMain: block.includes("main display"),
          isLaptop: typeMatch && typeMatch[1].includes("MacBook"),
          w: parseInt(resMatch[1]),
          h: parseInt(resMatch[2]),
          x: parseInt(originMatch[1]),
          y: parseInt(originMatch[2]),
        });
      }
    }
    _screenOriginsCache = screens;
    _screenOriginsAt = Date.now();
    return screens;
  } catch { return []; }
}

// Set mpv to floating mode (ontop, no geometry change — stays on current screen)
async function floatTopRight(wid) {
  if (wid) try { execSync(`aerospace layout floating --window-id ${wid}`, { stdio: "ignore" }); } catch {}
  try { await mpvCommand(["set_property", "ontop", true]); } catch {}
}

// Float mpv window to top-right of a specific screen (with fullscreen bounce to move it there)
async function floatOnScreen(wid, screenIdx) {
  try {
    await mpvCommand(["set_property", "fs-screen", screenIdx]);
    await mpvCommand(["set_property", "fullscreen", true]);
    await new Promise(r => setTimeout(r, 300));
    await mpvCommand(["set_property", "fullscreen", false]);
    await new Promise(r => setTimeout(r, 300));
    await mpvCommand(["set_property", "geometry", "38%-12+38"]);
  } catch {}
  try { await mpvCommand(["set_property", "ontop", true]); } catch {}
}

// Aerospace fullscreen (with dock visible) — exit mpv fullscreen first
let windowLock = false;
app.post("/api/maximize", async (req, res) => {
  if (windowLock) return res.json({ ok: true });
  windowLock = true;
  try {
    const fs = await mpvCommand(["get_property", "fullscreen"]);
    const wasFullscreen = fs?.data === true;
    if (wasFullscreen) {
      await mpvCommand(["set_property", "fullscreen", false]);
      await new Promise((r) => setTimeout(r, 500));
    }
    const force = req.body?.force === true;
    const wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
    if (!wid) return res.json({ ok: true });

    if (force || wasFullscreen || windowMode !== "maximize") {
      // Enter maximize — use currentMonitor to determine correct workspace
      try { await mpvCommand(["set_property", "ontop", false]); } catch {}
      const targetWs = currentMonitor === "laptop" ? "8" : "1";
      try {
        execSync(`aerospace move-node-to-workspace --window-id ${wid} ${targetWs}`, { stdio: "ignore" });
        execSync(`aerospace workspace ${targetWs}`, { stdio: "ignore" });
      } catch {}
      execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" });
      execSync(`aerospace fullscreen --no-outer-gaps on --window-id ${wid}`, { stdio: "ignore" });
      windowMode = "maximize";
    } else {
      // Already maximized — exit to floating with resize via AppleScript
      try {
        const screens = getScreenOrigins();
        const fsScreen = await mpvCommand(["get_property", "fs-screen"]).catch(() => ({ data: 0 }));
        const screen = screens[fsScreen?.data] || screens.find(s => s.isMain) || screens[0];
        const w = Math.round(screen.w * 0.38);
        const h = Math.round(w * 9 / 16);
        const posX = screen.x + screen.w - w - 12;
        const posY = screen.y + 38;
        execSync(`osascript -e 'tell application "System Events" to tell process "mpv" to set size of first window to {${w}, ${h}}'`, { stdio: "ignore" });
        execSync(`osascript -e 'tell application "System Events" to tell process "mpv" to set position of first window to {${posX}, ${posY}}'`, { stdio: "ignore" });
      } catch {}
      try { await mpvCommand(["set_property", "ontop", true]); } catch {}
      windowMode = "floating";
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Maximize failed:", err.message);
    res.status(500).json({ error: "Maximize failed" });
  } finally {
    windowLock = false;
  }
});

// Toggle fullscreen on/off — resize when exiting to fit current screen
app.post("/api/fullscreen", async (_req, res) => {
  if (windowLock) return res.json({ ok: true });
  windowLock = true;
  try {
    const fs = await mpvCommand(["get_property", "fullscreen"]);
    if (fs?.data === true) {
      await mpvCommand(["set_property", "fullscreen", false]);
      await new Promise((r) => setTimeout(r, 400));
      const wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
      if (wid) await floatTopRight(wid);
      windowMode = "floating";
    } else {
      await mpvCommand(["set_property", "ontop", false]);
      await mpvCommand(["set_property", "fullscreen", true]);
      windowMode = "fullscreen";
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Fullscreen toggle failed" });
  } finally {
    windowLock = false;
  }
});

// Toggle display resolution (1280x720 <-> 2560x1440)
app.post("/api/toggle-resolution", async (_req, res) => {
  try {
    execSync(`${require("os").homedir()}/.config/aerospace/scripts/toggle-resolution.sh`, { stdio: "ignore" });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Resolution toggle failed" });
  }
});

// Get a friend's last-known location from Find My via OCR.
//
// Find My's friend cache is E2E encrypted and Shortcuts doesn't expose
// Get-Current-Location-of-Person on macOS — so we fall back to the
// battle-tested approach: open Find My, screenshot the laptop display,
// run Apple's Vision OCR on it, and parse the sidebar row that matches
// the requested name for address + freshness.
//
// Requires:
//   - Full Disk Access (already needed for other things)
//   - Screen Recording (just granted; applies to the parent app that
//     runs `screencapture`)
//   - Find My must be open on the laptop display (workspace 8) with
//     the People tab active — `/api/toggle-findmy` already sets that up
const FINDMY_OCR_PNG = "/tmp/ytctl-findmy.png";
const FINDMY_OCR_SWIFT = path.join(__dirname, "scripts", "ocr.swift");
let _lastFindmyFriend = null; // cache so repeated calls don't re-OCR
let _lastPinBounds = null; // used by /api/findmy-crop.png
// Stealth mode: when true, Find My is parked on aerospace workspace 9
// (never focused by either monitor), so it runs invisibly. OCR still
// works because screencapture -l <CGWindowID> captures by window id
// regardless of on-screen visibility.
let findmyStealth = false;
const FINDMY_STEALTH_FILE = path.join(__dirname, ".findmy-stealth.json");
try {
  const v = JSON.parse(fs.readFileSync(FINDMY_STEALTH_FILE, "utf8"));
  findmyStealth = !!v.on;
} catch {}
const FINDMY_WINDOW_ID_SWIFT = path.join(__dirname, "scripts", "find-window-id.swift");
async function findmyWindowId() {
  try {
    const { stdout } = await execFileP("swift", [FINDMY_WINDOW_ID_SWIFT, "find my"], { timeout: 5000 });
    const id = parseInt(stdout.trim(), 10);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch { return null; }
}
// Concurrent callers share one in-flight OCR run. Without this, two
// overlapping requests both screenshot to the same /tmp path and
// corrupt each other's OCR results mid-write.
let _findmyInFlight = null;
app.get("/api/findmy-friend", async (req, res) => {
  const name = (req.query.name || "").toLowerCase();
  const force = req.query.force === "1";
  if (!name) return res.status(400).json({ error: "Missing name" });
  if (!force && _lastFindmyFriend && _lastFindmyFriend.name === name && (Date.now() - _lastFindmyFriend.at) < 20000) {
    return res.json(_lastFindmyFriend.result);
  }
  if (_findmyInFlight) {
    try { return res.json(await _findmyInFlight); }
    catch { return res.json({ ok: false, reason: "error" }); }
  }
  _findmyInFlight = (async () => {
    try {
    // 1. Confirm Find My is running; bail if not
    const { stdout: existsOut } = await execFileP("osascript", ["-e",
      'tell application "System Events" to exists process "FindMy"']);
    if (existsOut.trim() !== "true") {
      const r = { ok: false, reason: "not-running", hint: "Open Find My first" };
      if (!res.headersSent) res.json(r);
      return r;
    }
    // 2. Screenshot Find My. In normal mode we grab laptop display 2
    // (where FM lives). In stealth mode FM is parked on a non-visible
    // aerospace workspace; capture by CGWindowID instead.
    async function snapFindMy() {
      if (findmyStealth) {
        const wid = await findmyWindowId();
        if (wid) {
          await execFileP("screencapture", ["-l", String(wid), "-x", FINDMY_OCR_PNG]);
          return;
        }
      }
      await execFileP("screencapture", ["-D", "2", "-x", FINDMY_OCR_PNG]);
    }
    await snapFindMy();
    // Find My auto-centers on the selected friend when the app
    // gains focus, so an explicit click-to-center is only needed if
    // the map isn't already focused on Maria. In stealth we never
    // activate the window, so the map stays wherever it last was —
    // cross-street and crop are best-effort.
    // 3. OCR + parse. Wrapped so we can retry-with-fresh-screenshot
    //    if the first pass doesn't find a distance (Find My briefly
    //    blanks it during its spinner state).
    const DIST_RE = /^(\d+(?:\.\d+)?)\s*(mi|km|ft|m|yd)\b\.?$/i;
    async function ocrPass() {
      const { stdout: ocr } = await execFileP("swift", [FINDMY_OCR_SWIFT, FINDMY_OCR_PNG], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      const rows = ocr.split("\n").filter(Boolean).map(l => {
        const [bbox, ...rest] = l.split("\t");
        const [x, y, w, h] = bbox.split(",").map(Number);
        return { x, y, w, h, text: rest.join("\t") };
      });
      const matches = rows.filter(r => r.text.toLowerCase().includes(name)).sort((a, b) => a.y - b.y);
      if (matches.length === 0) return { notFound: true };
      const header = matches[0];
      const pinLabel = matches.find(m => m.x > 500);
      const crossStreet = pinLabel ? nearestCrossStreet(rows, {
        cx: pinLabel.x + pinLabel.w / 2,
        cy: pinLabel.y + pinLabel.h / 2,
      }) : null;
      const near = rows
        .filter(r => r.x < 700 && Math.abs(r.y - header.y) < 60)
        .filter(r => DIST_RE.test(r.text.trim()));
      const distRow = near.sort((a, b) => Math.abs(a.y - header.y) - Math.abs(b.y - header.y))[0];
      const distance = distRow ? distRow.text.trim().replace(/\.$/, "") : null;
      const detail = rows.find(r =>
        r.y > header.y &&
        r.y < header.y + 80 &&
        Math.abs(r.x - header.x) < 100 &&
        /[•·]/.test(r.text),
      );
      let address = "", timeFragment = "", ageMs = null;
      if (detail) {
        const parts = detail.text.split(/\s*[•·]\s*/);
        address = parts[0] || "";
        timeFragment = parts.slice(1).join(" · ");
        ageMs = parseAgeFragment(timeFragment);
      } else {
        const below = rows.filter(r => r.y > header.y && r.y < header.y + 80).sort((a, b) => a.y - b.y);
        if (below[0]) address = below[0].text;
      }
      return { header, pinLabel, rows, address, timeFragment, ageMs, crossStreet, distance };
    }
    let pass = await ocrPass();
    if (pass.notFound) {
      const result = { ok: false, reason: "not-found", hint: `No row containing "${name}"; check that Find My's People tab is visible` };
      _lastFindmyFriend = { name, result, at: Date.now() };
      if (!res.headersSent) res.json(result);
      return result;
    }
    // Retry if distance missing — Find My's UI frequently blanks
    // the distance column during its spinner state. A fresh
    // screenshot ~600ms later usually catches the rendered value.
    // Cap at 2 additional attempts (1.2s total delay) so /api/findmy-friend
    // stays responsive even in the pathological case.
    for (let attempt = 0; attempt < 2 && !pass.distance; attempt++) {
      await new Promise(r => setTimeout(r, 600));
      await snapFindMy();
      const next = await ocrPass();
      if (next.notFound) break;
      // Prefer any non-null field from the newer pass.
      pass = {
        ...pass,
        ...next,
        distance: next.distance || pass.distance,
        crossStreet: next.crossStreet || pass.crossStreet,
        pinLabel: next.pinLabel || pass.pinLabel,
      };
    }
    const { header, pinLabel, rows, address, timeFragment, ageMs, crossStreet, distance } = pass;
    const result = {
      ok: true,
      name: header.text,
      address,
      timeFragment,
      ageMs,
      crossStreet,
      distance,
      cropUrl: pinLabel ? `/api/findmy-crop.png?t=${Date.now()}` : null,
      ocrAt: Date.now(),
    };
    // Stash the pin bounds so /api/findmy-crop.png can crop against
    // the same FINDMY_OCR_PNG without re-running OCR.
    if (pinLabel) _lastPinBounds = { x: pinLabel.x, y: pinLabel.y, w: pinLabel.w, h: pinLabel.h };
    // Merge into cache: prefer any non-null field from the PREVIOUS
    // cached result over a newly-null one. Find My flickers its
    // distance / crossStreet / cropUrl blank for a moment during its
    // spinner state — without this, the null flicker poisons the
    // 20s cache and the client sees "distance: null" for 20 seconds
    // after every such blip.
    if (_lastFindmyFriend && _lastFindmyFriend.name === name && _lastFindmyFriend.result?.ok) {
      const prev = _lastFindmyFriend.result;
      if (!result.distance && prev.distance) result.distance = prev.distance;
      if (!result.crossStreet && prev.crossStreet) result.crossStreet = prev.crossStreet;
      if (!result.cropUrl && prev.cropUrl) result.cropUrl = prev.cropUrl;
    }
    _lastFindmyFriend = { name, result, at: Date.now() };
    res.json(result);
    return result;
    } catch (err) {
      const errResult = { ok: false, reason: "error", error: err.message };
      if (!res.headersSent) res.json(errResult);
      return errResult;
    } finally {
      _findmyInFlight = null;
    }
  })();
  // Wait for our own in-flight promise only so the error path above
  // has a chance to respond — outer function still returns quickly.
  try { await _findmyInFlight; } catch {}
});

// Read `displayplacer list` and return the origin {x, y} of the
// first display whose description contains <needle>. Falls back to
// the known Built-in laptop origin on this setup if parsing fails.
function parseDisplayplacerOrigin(stdout, needle) {
  if (!stdout) return { x: -1470, y: 124 };
  const blocks = stdout.split(/\n\n+/);
  for (const block of blocks) {
    const hasType = new RegExp(`Type:\\s*[^\\n]*${needle}`, "i").test(block);
    if (!hasType) continue;
    const m = block.match(/Origin:\s*\(([-\d]+),([-\d]+)\)/);
    if (m) return { x: +m[1], y: +m[2] };
  }
  return { x: -1470, y: 124 };
}

// Serve a cropped image of the map around the last-known friend pin.
// Uses macOS `sips` (pre-installed) to avoid adding a Node image lib.
// CROP_W/H chosen to show a ~2 block radius on a Retina screenshot.
const FINDMY_CROP_PNG = "/tmp/ytctl-findmy-crop.png";
const CROP_W = 900, CROP_H = 700;
app.get("/api/findmy-crop.png", async (_req, res) => {
  try {
    if (!_lastPinBounds) return res.status(404).send("no pin yet");
    // The OCR bbox wraps Maria's row on the map: [circular avatar pin]
    // [email label]. The avatar is a circle on the LEFT of the box,
    // roughly h×h pixels wide. Centering on the bbox center puts the
    // label at crop-center and the pin off to the left. Instead center
    // on the avatar: x = left + h/2, y = vertical center.
    const cx = _lastPinBounds.x + _lastPinBounds.h / 2;
    const cy = _lastPinBounds.y + _lastPinBounds.h / 2;
    // Probe source image size so we can clamp crop offset to stay
    // inside bounds (sips errors out if offset + crop size > image).
    const { stdout: dims } = await execFileP("sips", ["-g", "pixelWidth", "-g", "pixelHeight", FINDMY_OCR_PNG]);
    const W = parseInt((dims.match(/pixelWidth:\s*(\d+)/) || [])[1] || "0");
    const H = parseInt((dims.match(/pixelHeight:\s*(\d+)/) || [])[1] || "0");
    if (!W || !H) return res.status(500).send("bad source dims");
    const ox = Math.max(0, Math.min(W - CROP_W, Math.round(cx - CROP_W / 2)));
    const oy = Math.max(0, Math.min(H - CROP_H, Math.round(cy - CROP_H / 2)));
    // sips --cropOffset takes Y first, THEN X. The man page calls
    // them "offsetY offsetH" but the second arg is actually the X
    // offset. Getting this wrong silently crops from a different
    // region (sips doesn't error).
    await execFileP("sips", [
      "-c", String(CROP_H), String(CROP_W),
      "--cropOffset", String(oy), String(ox),
      FINDMY_OCR_PNG, "--out", FINDMY_CROP_PNG,
    ]);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(FINDMY_CROP_PNG);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Pick the two closest different-named street labels to {cx, cy} and
// join them as "A & B". Handles Apple Maps' all-caps "SPRING ST"
// format plus common OCR mistakes ("1K ST" → skip).
function nearestCrossStreet(rows, { cx, cy }) {
  const STREET_RE = /^([A-Z0-9][A-Z0-9'\s]+?)\s+(ST|AVE|AV|BLVD|BWY|PL|RD|DR|LN|HWY|WAY|PKWY|TPKE|BROADWAY)$/;
  const streets = [];
  for (const r of rows) {
    const t = r.text.trim();
    const m = t.match(STREET_RE);
    if (!m) continue;
    // Skip obvious OCR garbage — street names are usually ≥3 letters
    // and don't start with lone digits (e.g. "1K ST" is noise).
    if (m[1].length < 2 || /^\d/.test(m[1])) continue;
    const centerX = r.x + r.w / 2;
    const centerY = r.y + r.h / 2;
    const dist = Math.hypot(centerX - cx, centerY - cy);
    streets.push({ name: toTitleCase(t), dist });
  }
  if (streets.length === 0) return null;
  streets.sort((a, b) => a.dist - b.dist);
  // Dedupe by name — keep the closest instance of each unique street
  const seen = new Set();
  const unique = [];
  for (const s of streets) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    unique.push(s);
    if (unique.length === 2) break;
  }
  if (unique.length < 2) return unique[0]?.name || null;
  return `${unique[0].name} & ${unique[1].name}`;
}

function toTitleCase(s) {
  return s.toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase())
    .replace(/\bSt\b/g, "St")
    .replace(/\bAve\b/g, "Ave");
}

// "Now" / "3 min ago" / "1h ago" / "2:45 PM" → ms since that time.
// Returns null if unparseable (e.g. "2:45 PM" depends on today).
function parseAgeFragment(s) {
  if (!s) return null;
  // Strip trailing punctuation and normalize whitespace (Find My
  // sometimes emits "2 min. ago" with a period after the unit).
  const t = s.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
  if (t === "now" || t === "just now") return 0;
  let m;
  m = t.match(/^(\d+)\s*(?:sec|s)(?:ond)?s?\s*ago$/); if (m) return +m[1] * 1000;
  m = t.match(/^(\d+)\s*(?:min|m)(?:ute)?s?\s*ago$/); if (m) return +m[1] * 60 * 1000;
  m = t.match(/^(\d+)\s*(?:hr|h)(?:our)?s?\s*ago$/); if (m) return +m[1] * 60 * 60 * 1000;
  m = t.match(/^(\d+)\s*d(?:ay)?s?\s*ago$/); if (m) return +m[1] * 24 * 60 * 60 * 1000;
  return null;
}

// Toggle stealth mode. When ON, Find My's process is hidden via
// System Events (`set visible ... to false`). The window buffer
// stays live so `screencapture -l <CGWindowID>` still grabs it — we
// OCR from the offscreen bitmap. Turning OFF reactivates the app
// back into workspace 8 fullscreen. State persists across restarts.
// Push Find My into stealth pose: floating layout, pushed to the
// bottom-left corner of the laptop so macOS's offscreen-clamp leaves
// only a ~20×20 sliver visible. The window is technically onscreen
// (required by macOS), but functionally invisible. activate no longer
// flashes a full-size window across the monitor.
async function parkFindMyStealth(wid) {
  if (!wid) return;
  // Hide FIRST so the user doesn't see the intermediate aerospace
  // mode changes + resize + reposition. All those ops still apply to
  // a hidden process via System Events; once visibility flips back
  // on (e.g. via refresh activate), the window reappears at the
  // already-parked corner location.
  await execFileP("osascript", ["-e",
    'tell application "System Events" to set visible of (first process whose name is "FindMy") to false']).catch(() => {});
  await execFileP("aerospace", ["fullscreen", "off", "--window-id", wid]).catch(() => {});
  await execFileP("aerospace", ["move-node-to-workspace", "1", "--window-id", wid]).catch(() => {});
  await execFileP("aerospace", ["layout", "floating", "--window-id", wid]).catch(() => {});
  await execFileP("osascript", ["-e",
    'tell application "System Events" to tell process "FindMy" to set size of window 1 to {1470, 923}']).catch(() => {});
  // (2520, 1322) is what macOS clamps (5000, 3000) to on this setup
  // — the max-offset that still keeps a ~40×120 sliver on the LG.
  // Set it directly because a hidden window isn't subject to the
  // clamp, so overshooting lands the window fully off-screen and
  // AppKit stops maintaining the framebuffer (breaking OCR).
  await execFileP("osascript", ["-e",
    'tell application "System Events" to tell process "FindMy" to set position of window 1 to {2520, 1322}']).catch(() => {});
  // Belt-and-suspenders re-hide in case any of the aerospace calls
  // above transiently forced visibility.
  await execFileP("osascript", ["-e",
    'tell application "System Events" to set visible of (first process whose name is "FindMy") to false']).catch(() => {});
}

async function parkFindMyVisible(wid) {
  if (!wid) return;
  await execFileP("aerospace", ["layout", "tiling", "--window-id", wid]).catch(() => {});
  await execFileP("aerospace", ["move-node-to-workspace", "9", "--window-id", wid]).catch(() => {});
  await execFileP("aerospace", ["workspace", "9"]).catch(() => {});
  await execFileP("aerospace", ["focus", "--window-id", wid]).catch(() => {});
  await execFileP("aerospace", ["fullscreen", "--no-outer-gaps", "on", "--window-id", wid]).catch(() => {});
}

app.post("/api/findmy-stealth", async (req, res) => {
  const on = !!req.body?.on;
  findmyStealth = on;
  try { fs.writeFileSync(FINDMY_STEALTH_FILE, JSON.stringify({ on })); } catch {}
  try {
    const { stdout } = await execFileP("aerospace", ["list-windows", "--all"]);
    const line = stdout.split("\n").find(l => /find\s*my/i.test(l));
    const wid = line ? line.split("|")[0].trim() : "";
    if (on) {
      await parkFindMyStealth(wid);
    } else {
      await parkFindMyVisible(wid);
      await execFileP("osascript", ["-e", 'tell application "FindMy" to activate']).catch(() => {});
    }
  } catch {}
  res.json({ ok: true, on });
});

app.get("/api/findmy-stealth", (_req, res) => res.json({ on: findmyStealth }));

// Refresh Find My's location data without relaunching.
// Hide → short wait → activate. Bringing Find My from background to
// foreground re-polls device locations; this is the cheap refresh
// compared to quit+relaunch (which forces the map/panels to re-render
// from scratch).
app.post("/api/refresh-findmy", async (_req, res) => {
  try {
    // In stealth: window is already parked as a tiny sliver in the
    // laptop's corner (via parkFindMyStealth). Activate just brings it
    // to front in that same spot — no workspace switch, no monitor
    // flash. Triggers Find My's re-poll.
    await execFileP("osascript", ["-e",
      'tell application "FindMy" to activate']).catch(() => {});
    // Re-enforce the stealth park in case activate nudged anything.
    if (findmyStealth) {
      const { stdout } = await execFileP("aerospace", ["list-windows", "--all"]);
      const line = stdout.split("\n").find(l => /find\s*my/i.test(l));
      const wid = line ? line.split("|")[0].trim() : "";
      if (wid) parkFindMyStealth(wid);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Current Find My running state (for the secret menu to render a
// "Show" vs "Close" label without the user having to guess).
app.get("/api/findmy-status", async (_req, res) => {
  try {
    const { stdout: existsOut } = await execFileP("osascript", ["-e",
      'tell application "System Events" to exists process "FindMy"']);
    if (existsOut.trim() !== "true") return res.json({ visible: false, running: false });
    const { stdout: visOut } = await execFileP("osascript", ["-e",
      'tell application "System Events" to get visible of process "FindMy"']);
    res.json({ visible: visOut.trim() === "true", running: true });
  } catch { res.json({ visible: false, running: false }); }
});

// Toggle Find My on the MacBook Air built-in display.
// If running: quit the app (window closes entirely).
// If not running: launch, focus, move to workspace 8, fullscreen.
// This is a true open/close toggle — not hide/show, not relaunch.
app.post("/api/toggle-findmy", async (_req, res) => {
  try {
    // Is FindMy running?
    let running = false;
    try {
      const { stdout } = await execFileP("osascript", ["-e",
        'tell application "System Events" to exists process "FindMy"']);
      running = stdout.trim() === "true";
    } catch {}

    if (running) {
      // Quit (polite — Find My flushes its caches). Window closes
      // because the app exits.
      await execFileP("osascript", ["-e", 'tell application "FindMy" to quit']).catch(() => {});
      return res.json({ ok: true, running: false });
    }

    // Launch Find My. `-g` means don't bring to front / don't activate
    // in stealth — otherwise opening from the dock order would briefly
    // make the window visible, and user's aerospace rules would pull
    // it onto the laptop workspace, producing a flash.
    const openArgs = findmyStealth ? ["-g", "-a", "FindMy"] : ["-a", "FindMy"];
    await execFileP("open", openArgs).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
    if (!findmyStealth) {
      // Only activate in non-stealth mode — same flash-avoidance reason.
      await execFileP("osascript", ["-e",
        'tell application "FindMy" to activate']).catch(() => {});
    }
    try {
      let wid = "";
      for (let i = 0; i < 15; i++) {
        const { stdout } = await execFileP("aerospace", ["list-windows", "--all"]);
        const line = stdout.split("\n").find(l => /find\s*my/i.test(l));
        if (line) { wid = line.split("|")[0].trim(); break; }
        await new Promise(r => setTimeout(r, 200));
      }
      if (wid) {
        if (findmyStealth) await parkFindMyStealth(wid);
        else await parkFindMyVisible(wid);
      }
    } catch {}
    res.json({ ok: true, running: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WebSocket server for phone sync ──
const http = require("http");
const WebSocket = require("ws");
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// ── WebSocket terminal (xterm.js ↔ tmux attach) ──
let pty;
try { pty = require("@lydell/node-pty"); } catch { try { pty = require("node-pty"); } catch (e) { console.error("node-pty not available:", e.message); } }
const wssTerm = new WebSocket.Server({ noServer: true });

// ── Live chat WebSocket: server polls YouTube, drips messages to subscribers ──
const wssChat = new WebSocket.Server({ noServer: true });
// Map<videoId, { clients, chatId, seen, pageToken, pollTimer, flushTimer, queue, nextPollAt, primed, buffer }>
const chatRooms = new Map();
const CHAT_BUFFER_SIZE = 30;   // last-N messages replayed to late joiners
const CHAT_INITIAL_SHOW = 12;  // how many backlog messages the first client sees

function chatBroadcast(room, msg) {
  const str = JSON.stringify(msg);
  for (const ws of room.clients) {
    if (ws.readyState === 1) ws.send(str);
  }
}

function chatStopRoom(videoId) {
  const room = chatRooms.get(videoId);
  if (!room) return;
  if (room.pollTimer) clearTimeout(room.pollTimer);
  if (room.flushTimer) clearTimeout(room.flushTimer);
  chatRooms.delete(videoId);
}

async function chatPollOnce(videoId) {
  const room = chatRooms.get(videoId);
  if (!room) return;
  try {
    const token = await getAccessToken();
    if (!room.chatId) {
      const vidData = await ytFetch("videos", { part: "liveStreamingDetails", id: videoId }, token);
      room.chatId = vidData.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
      if (!room.chatId) {
        chatBroadcast(room, { type: "error", error: "No active chat" });
        // Retry every 30s in case the stream goes live later
        room.pollTimer = setTimeout(() => chatPollOnce(videoId), 30000);
        return;
      }
    }
    const params = { part: "snippet,authorDetails", liveChatId: room.chatId, maxResults: 200 };
    if (room.pageToken) params.pageToken = room.pageToken;
    const chatData = await ytFetch("liveChat/messages", params, token);
    const nextMs = chatData.pollingIntervalMillis || 5000;
    room.nextPollAt = Date.now() + nextMs;
    room.pageToken = chatData.nextPageToken || null;
    const fresh = [];
    for (const m of chatData.items || []) {
      const id = m.id || ((m.snippet?.publishedAt || "") + (m.authorDetails?.displayName || ""));
      if (room.seen.has(id)) continue;
      room.seen.add(id);
      fresh.push({
        id,
        author: m.authorDetails?.displayName || "",
        text: m.snippet?.displayMessage || "",
        isMod: !!m.authorDetails?.isChatModerator,
        isOwner: !!m.authorDetails?.isChatOwner,
        time: m.snippet?.publishedAt,
      });
    }
    // Trim seen set so it doesn't grow forever
    if (room.seen.size > 2000) {
      const arr = Array.from(room.seen);
      room.seen = new Set(arr.slice(-1000));
    }
    for (const m of fresh) {
      room.buffer.push(m);
      if (room.buffer.length > CHAT_BUFFER_SIZE) room.buffer.shift();
    }
    // On the very first poll, the API can return up to 200 messages of
    // backlog. Broadcast just the last CHAT_INITIAL_SHOW so clients see
    // recent context immediately without being overwhelmed.
    const toSend = room.primed ? fresh : fresh.slice(-CHAT_INITIAL_SHOW);
    for (const m of toSend) room.queue.push(m);
    if (toSend.length && !room.flushTimer) chatFlushStep(videoId);
    room.primed = true;
    room.pollTimer = setTimeout(() => chatPollOnce(videoId), nextMs);
  } catch (err) {
    console.error("Live chat poll error:", err.message);
    room.pollTimer = setTimeout(() => chatPollOnce(videoId), 5000);
  }
}

function chatFlushStep(videoId) {
  const room = chatRooms.get(videoId);
  if (!room) return;
  room.flushTimer = null;
  if (room.queue.length === 0) return;
  // Target: finish flushing the queue before the next poll. If the backlog is
  // huge, burst multiple messages per step so we don't fall behind a fast chat.
  const remaining = Math.max(200, (room.nextPollAt || Date.now() + 1000) - Date.now());
  const idealPerMsg = remaining / room.queue.length;
  const perMsg = Math.max(40, Math.min(500, idealPerMsg));
  // How many messages to drip this step
  const burst = idealPerMsg < 40 ? Math.max(1, Math.ceil(40 / idealPerMsg)) : 1;
  for (let i = 0; i < burst && room.queue.length > 0; i++) {
    chatBroadcast(room, { type: "message", message: room.queue.shift() });
  }
  if (room.queue.length === 0) return;
  room.flushTimer = setTimeout(() => chatFlushStep(videoId), perMsg);
}

wssChat.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const videoId = url.searchParams.get("videoId");
  if (!videoId) { ws.close(); return; }
  let room = chatRooms.get(videoId);
  if (!room) {
    room = {
      clients: new Set(),
      chatId: null,
      seen: new Set(),
      pageToken: null,
      pollTimer: null,
      flushTimer: null,
      queue: [],
      nextPollAt: 0,
      primed: false,
      buffer: [],
    };
    chatRooms.set(videoId, room);
    chatPollOnce(videoId);
  }
  room.clients.add(ws);
  // Replay recent buffer so late joiners get context. Only send if the room
  // has already been primed (otherwise the buffer is the backlog the first
  // client explicitly wants to skip).
  if (room.primed && room.buffer.length > 0) {
    for (const m of room.buffer) {
      try { ws.send(JSON.stringify({ type: "message", message: m })); } catch {}
    }
  }
  ws.on("close", () => {
    room.clients.delete(ws);
    if (room.clients.size === 0) chatStopRoom(videoId);
  });
  ws.on("error", () => {});
});
let claudeState = 'idle'; // 'idle' | 'thinking' | 'waiting'
let claudeOptions = []; // [{n: '1', text: 'Option A'}, ...]
let claudeQuestion = '';
let _claudeWaitingTimer = null;
let _lastCapture = 0;
let _lastActiveWindow = '';
function broadcastClaude() {
  const msg = JSON.stringify({ type: 'claude', claudeState, claudeOptions: claudeOptions.length ? claudeOptions : undefined, claudeQuestion: claudeQuestion || undefined });
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}
let _tmuxSwitchAt = 0;
let _tmuxSwitchTimer = null;
let _ptyBuffer = ''; // rolling buffer of recent pty output
let tmuxWindows = [];

let _tmuxRefreshInFlight = false;
async function refreshTmuxWindows() {
  // Async + in-flight guard. Was `execSync` called inside the 1Hz WS
  // broadcast — with tmux's occasional 100-1000ms hitches that blocked
  // the Node event loop, killed all WS heartbeats, and caused the
  // reconnect storm visible in server logs.
  if (_tmuxRefreshInFlight) return;
  _tmuxRefreshInFlight = true;
  try {
    const { stdout } = await execFileP("tmux", ["list-windows", "-t", "0", "-F", "#{window_index}:#{window_name}:#{window_active}"], { timeout: 2000 });
    tmuxWindows = stdout.trim().split("\n").map(line => {
      const [index, name, active] = line.split(":");
      return { index: +index, name, active: active === "1" };
    });
  } catch { tmuxWindows = []; }
  finally { _tmuxRefreshInFlight = false; }
  const active = tmuxWindows.find(w => w.active);
  if (active && String(active.index) !== _lastActiveWindow) {
    _lastActiveWindow = String(active.index);
    claudeOptions = [];
    claudeQuestion = '';
    claudeState = 'idle';
  }
}
// Refresh on its own 3s timer, not inside the broadcast loop.
setInterval(() => { refreshTmuxWindows(); }, 3000);

app.post("/api/tmux-send", (req, res) => {
  const { keys } = req.body;
  if (!keys) return res.status(400).json({ error: "No keys" });
  try {
    execSync(`tmux send-keys -t 0 "${keys}" Enter`, { stdio: "ignore" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/tmux-rename", (req, res) => {
  const { index, name } = req.body;
  if (index == null || !name) return res.status(400).json({ error: "index and name required" });
  const safe = String(name).replace(/[^a-zA-Z0-9_\-. ]/g, "").slice(0, 32);
  if (!safe) return res.status(400).json({ error: "name empty after sanitize" });
  try {
    execSync(`tmux rename-window -t 0:${parseInt(index)} ${JSON.stringify(safe)}`, { stdio: "ignore" });
    refreshTmuxWindows();
    res.json({ ok: true, name: safe });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/tmux-select", (req, res) => {
  const { index } = req.body;
  try {
    execSync(`tmux select-window -t 0:${index}`, { stdio: "ignore" });
    refreshTmuxWindows();
    claudeOptions = [];
    claudeQuestion = '';
    claudeState = 'idle';
    _tmuxSwitchAt = Date.now();
    if (_tmuxSwitchTimer) clearTimeout(_tmuxSwitchTimer);
    // After cooldown, check if new tab has an active prompt
    _tmuxSwitchTimer = setTimeout(() => {
      _tmuxSwitchTimer = null;
      try {
        const pane = execSync('tmux capture-pane -p', { encoding: 'utf8', timeout: 1000 });
        if (/Enter to select|Esc to cancel/.test(pane)) {
          claudeState = 'waiting';
          const lines = pane.split('\n');
          let selectIdx = -1;
          for (let i = lines.length - 1; i >= 0; i--) {
            if (/^Enter to select|^Esc to cancel/.test(lines[i].trim())) { selectIdx = i; break; }
          }
          if (selectIdx > 0) {
            const opts = [];
            let question = '';
            for (let i = selectIdx - 1; i >= Math.max(0, selectIdx - 15); i--) {
              const line = lines[i];
              const m = line.match(/^\s*[❯►]?\s*(\d)[.:]\s+(\S.{0,40})/);
              if (m && parseInt(m[1]) >= 1 && parseInt(m[1]) <= 4 && !/^Type something/.test(m[2].trim())) opts.unshift({ n: m[1], text: m[2].trim() });
              if (!m && opts.length === 0) {
                const h = line.match(/^\s*[❯►]\s+(\S.{1,40})/);
                if (h) opts.unshift({ n: '1', text: h[1].trim() });
              }
              const q = line.match(/[☐●☑]\s+(.+)/);
              if (q) { question = q[1].trim(); break; }
              if (opts.length > 0 && !m && line.trim().length > 2 && !/^\s{4,}/.test(line) && !/^[❯►⏺⎿●─]/.test(line.trim()) && !/^Enter|^Esc to/.test(line.trim()) && !/Chat about/.test(line) && !/Type something/.test(line) && !/Tab to amend/.test(line)) {
                question = line.trim();
                break;
              }
            }
            if (opts.length >= 2) {
              claudeOptions = opts.slice(0, 4);
              if (question) claudeQuestion = question;
              broadcastClaude();
            }
          }
        }
      } catch {}
    }, 2000);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

httpServer.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws/sync") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else if (req.url === "/ws/terminal") {
    wssTerm.handleUpgrade(req, socket, head, (ws) => wssTerm.emit("connection", ws, req));
  } else if (req.url && req.url.startsWith("/ws/livechat")) {
    wssChat.handleUpgrade(req, socket, head, (ws) => wssChat.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});
wssTerm.on("connection", (ws) => {
  console.log("  Terminal: WebSocket connected");
  if (!pty) { ws.send("[terminal not available]\r\n"); ws.close(); return; }
  let shell;
  try {
    shell = pty.spawn("/opt/homebrew/bin/tmux", ["new-session", "-A", "-t", "0"], {
    name: "xterm-256color",
    cols: 54,
    rows: 25,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  // Hide tmux status bar for web session, restore on disconnect
  setTimeout(() => { try { execSync("tmux set status off", { stdio: "ignore" }); } catch {} }, 500);
  shell.onData((data) => {
    try { ws.send(data); } catch {}
    // Detect Claude Code state: waiting for input, thinking, or idle
    const stripped = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b[()][AB012]/g, "");
    const compact = stripped.replace(/[\r\n\s]+/g, "");
    // Keep rolling buffer of stripped pty output
    _ptyBuffer += stripped;
    if (_ptyBuffer.length > 5000) _ptyBuffer = _ptyBuffer.slice(-3000);
    if (Date.now() - _tmuxSwitchAt < 2000) {
      // Ignore pty triggers right after tmux switch (scrollback noise)
    } else if (/Esctocancel/.test(compact) || /Waitingforpermission/.test(compact)) {
      claudeState = 'waiting';
      claudeOptions = [];
      claudeQuestion = '';
      // Debounce broadcast — option parsing below needs time to find options in capture-pane
      if (_claudeWaitingTimer) clearTimeout(_claudeWaitingTimer);
      _claudeWaitingTimer = setTimeout(() => { _claudeWaitingTimer = null; if (claudeState === 'waiting') broadcastClaude(); }, 500);
    } else if (/tokens\)|Cooked|Sautéed|Crunched|Marinated|Braised|Simmered|Garnished|⏺|✢|Useranswered|❯|⎿|thoughtfor/.test(compact)) {
      claudeState = 'idle';
      claudeOptions = [];
      claudeQuestion = '';
      broadcastClaude();
    } else if (/Whirlpooling|Channeling|Recombobulating|Flibbertigibbeting|Composing|Generating|Catapulting/.test(compact) || /^[✻✳✽✶✷]/.test(stripped.trim())) {
      claudeState = 'thinking';
      claudeOptions = [];
      claudeQuestion = '';
      broadcastClaude();
    }
    // Capture options when "Enter to select" appears (separate from state detection)
    if ((/Entertoselect/.test(compact) || /Tabtoamend/.test(compact)) && Date.now() - _tmuxSwitchAt > 2000) {
      claudeOptions = [];
      claudeQuestion = '';
      try {
        const pane = execSync('tmux capture-pane -p', { encoding: 'utf8', timeout: 1000 });
        const lines = pane.split('\n');
        let selectIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (/^Enter to select|^Esc to cancel/.test(lines[i].trim())) { selectIdx = i; break; }
        }
        if (selectIdx > 0) {
          const opts = [];
          let question = '';
          for (let i = selectIdx - 1; i >= Math.max(0, selectIdx - 15); i--) {
            const line = lines[i];
            const m = line.match(/^\s*[❯►]?\s*(\d)[.:]\s+(\S.{0,40})/);
            if (m && parseInt(m[1]) >= 1 && parseInt(m[1]) <= 4 && !/^Type something/.test(m[2].trim()) && !/^Other$/.test(m[2].trim())) opts.unshift({ n: m[1], text: m[2].trim() });
            if (!m && opts.length === 0) {
              const h = line.match(/^\s*[❯►]\s+(\S.{1,40})/);
              if (h) opts.unshift({ n: '1', text: h[1].trim() });
            }
            const q = line.match(/[☐●☑]\s+(.+)/);
            if (q) { question = q[1].trim(); break; }
            // Non-option, non-description text line above options = question
            if (opts.length > 0 && !m && line.trim().length > 2 && !/^\s{4,}/.test(line) && !/^[❯►⏺⎿●─]/.test(line.trim()) && !/^Enter|^Esc to/.test(line.trim()) && !/Chat about/.test(line) && !/Type something/.test(line) && !/Tab to amend/.test(line)) {
              question = line.trim();
              break;
            }
          }
          if (opts.length >= 2) {
            claudeOptions = opts.slice(0, 4);
            if (question) claudeQuestion = question;
            if (_claudeWaitingTimer) { clearTimeout(_claudeWaitingTimer); _claudeWaitingTimer = null; }
            broadcastClaude();
          }
        }
      } catch {}
    }
  });
  ws.on("message", (msg) => {
    const str = msg.toString();
    if (str.startsWith("\x01r")) {
      const [cols, rows] = str.slice(2).split(",").map(Number);
      if (cols > 0 && rows > 0) shell.resize(cols, rows);
    } else {
      shell.write(str);
    }
  });
  ws.on("close", () => {
    console.log("  Terminal: WebSocket disconnected");
    try { execSync("tmux set status on", { stdio: "ignore" }); } catch {}
    shell.kill();
  });
  shell.onExit(() => { try { ws.close(); } catch {} });
  } catch (e) {
    console.error("  Terminal: PTY spawn failed:", e.message);
    ws.send(`[terminal error: ${e.message}]\r\n`);
    ws.close();
  }
});

wss.on("connection", (ws) => {
  console.log("  Phone sync: WebSocket connected");
  startWsSync();
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("error", (err) => { console.error("  WS error:", err.message); });
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", serverTs: Date.now(), clientTs: data.clientTs }));
      } else if (data.type === "phone-state") {
        _phoneSyncDebug = { ...data, ts: Date.now() };
        if (data.debug) console.log("  Phone DVR:", data.debug);
        if (process.env.DEBUG_DRIFT) {
          if (data.mpvPos !== undefined) console.log(`  Sync: drift=${data.drift} mpv=${data.mpvPos} ph=${data.phonePos} el=${data.elapsed}`);
          if (data.mpvPdt !== undefined || data.phonePdt !== undefined) {
            console.log(`[drift] phone drift=${data.drift}s mpvPdt=${data.mpvPdt ? new Date(data.mpvPdt).toISOString().substring(11, 23) : '?'} phonePdt=${data.phonePdt ? new Date(data.phonePdt).toISOString().substring(11, 23) : '?'}`);
          }
        }
      } else if (data.type === "mpv-speed" && typeof data.speed === "number") {
        mpvCommand(["set_property", "speed", data.speed]).catch(() => {});
      }
    } catch {}
  });
  ws.on("close", () => {
    console.log("  Phone sync: WebSocket disconnected");
    if (wss.clients.size === 0 && wsSyncInterval) {
      clearInterval(wsSyncInterval);
      wsSyncInterval = null;
    }
  });
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);

// Push playback state to all connected phones
let wsSyncInterval = null;
// Cached mac status — refreshed every 10s to avoid expensive shell calls per WS tick
let _macStatusCache = { locked: false, screenOff: false, frontApp: '', ethernet: false, keepAwake: false };
let _macStatusInterval = null;
async function refreshMacStatus() {
  const results = await Promise.allSettled([
    execP(`ioreg -n Root -d1 -w0 | grep -o '"CGSSessionScreenIsLocked"=[a-zA-Z]*'`),
    execP(`system_profiler SPDisplaysDataType 2>/dev/null | grep "Display Asleep"`),
    execP(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`),
    execP(`ifconfig en3 | grep "status:"`),
  ]);
  _macStatusCache.locked = results[0].status === 'fulfilled' && results[0].value.stdout.includes("Yes");
  _macStatusCache.screenOff = results[1].status === 'fulfilled' && results[1].value.stdout.includes("Yes");
  _macStatusCache.frontApp = results[2].status === 'fulfilled' ? results[2].value.stdout.trim() : '';
  _macStatusCache.ethernet = results[3].status === 'fulfilled' && results[3].value.stdout.includes("active");
}
refreshMacStatus();
_macStatusInterval = setInterval(refreshMacStatus, 30000);
function startWsSync() {
  if (wsSyncInterval) return;
  wsSyncInterval = setInterval(async () => {
    if (wss.clients.size === 0) return;
    try {
      let state;
      if (activePlayer === "mpv" && nowPlaying) {
        try {
          // Invalidate immutable cache when video changes
          if (_mpvVideoInfoCache.url !== nowPlaying) {
            _mpvVideoInfoCache = { url: nowPlaying, height: null, videoCodec: null, hwdec: null };
          }
          const needInfo = _mpvVideoInfoCache.height == null
            || _mpvVideoInfoCache.videoCodec == null
            || _mpvVideoInfoCache.hwdec == null;
          const calls = [
            mpvCommand(["get_property", "time-pos"]),
            mpvCommand(["get_property", "duration"]),
            mpvCommand(["get_property", "pause"]),
            mpvCommand(["get_property", "file-format"]).catch(() => null),
            mpvCommand(["get_property", "path"]).catch(() => null),
            mpvCommand(["get_property", "speed"]).catch(() => null),
          ];
          if (needInfo) {
            calls.push(
              mpvCommand(["get_property", "height"]).catch(() => null),
              mpvCommand(["get_property", "video-format"]).catch(() => null),
              mpvCommand(["get_property", "hwdec-current"]).catch(() => null),
            );
          }
          const results = await Promise.all(calls);
          const [pos, dur, pause, fmt, mpvPath, speedR] = results;
          if (needInfo) {
            const [, , , , , , height, vcodec, hwdec] = results;
            if (height?.data != null) _mpvVideoInfoCache.height = height.data;
            if (vcodec?.data != null) _mpvVideoInfoCache.videoCodec = vcodec.data;
            if (hwdec?.data != null) _mpvVideoInfoCache.hwdec = hwdec.data;
          }
          const isHls = (fmt?.data || "").includes("hls");
          const paused = !!pause?.data;
          // Auto-hide/show on external pause (AirPods, media keys) — same logic as /api/playpause
          if (_lastPolledPaused !== null && paused !== _lastPolledPaused && windowMode !== "fullscreen") {
            // Fire-and-forget to avoid blocking the 1Hz WS broadcast loop
            (async () => {
              try {
                if (paused) {
                  await execFileP("osascript", ["-e", 'tell application "System Events" to set visible of process "mpv" to false']).catch(() => {});
                } else if (!phoneActive) {
                  await execFileP("osascript", ["-e", 'tell application "System Events" to set visible of process "mpv" to true']).catch(() => {});
                  await execFileP("osascript", ["-e", 'tell application "System Events" to set frontmost of process "mpv" to true']).catch(() => {});
                  if (windowMode === "maximize") {
                    const { stdout } = await execFileP("aerospace", ["list-windows", "--all"]).catch(() => ({ stdout: "" }));
                    const line = stdout.split("\n").find(l => /mpv/i.test(l));
                    const wid = line ? line.split("|")[0].trim() : "";
                    if (wid) {
                      await execFileP("aerospace", ["focus", "--window-id", wid]).catch(() => {});
                      await execFileP("aerospace", ["fullscreen", "--no-outer-gaps", "on", "--window-id", wid]).catch(() => {});
                    }
                  }
                }
              } catch {}
            })();
          }
          _lastPolledPaused = paused;
          const histDur = historyMap.get(nowPlaying)?.duration || 0;
          const reportedDur = dur?.data || 0;
          const timePos = pos?.data || 0;
          const onLiveProxy = !!(mpvPath?.data?.includes("/api/hls-live.m3u8"));
          const onSubProxy = !!(mpvPath?.data?.includes("/api/hls-sub.m3u8"));
          if (!onSubProxy && subProxyAnchor) subProxyAnchor = null;
          const dvrActive = onSubProxy;

          // ── Stable user PDT ──────────────────────────────────────
          // Two anchor systems, one per proxy mode:
          //
          //   Live proxy → `playbackAnchor`. Captured at steady state
          //     from cache offset. Use for smooth PDT advance at 1x
          //     during live playback.
          //
          //   Sub proxy → `subProxyAnchor` (set at /api/seek time with
          //     the user's INTENDED behindLive). Do NOT use cache-offset
          //     math here — it'd put the user at live edge even though
          //     they just scrubbed 2h back.
          //
          // MPV_DISPLAY_LAG_MS corrects for ffmpeg's internal live-HLS
          // buffer offset: ffmpeg defaults to `live_start_index=-3`
          // (3 segments behind the real live edge as a safety margin).
          // So the lag is 3 × segment_duration, which varies per stream
          // (YouTube's lofi uses 5s segments → 15s lag; other streams
          // use 2s segments → 6s lag). Read from the manifest's
          // TARGETDURATION tag via lastManifestTargetDur.
          // syncOffsetMs (from the UI slider) tunes further for stream-
          // specific fine adjustments.
          const MPV_DISPLAY_LAG_MS = lastManifestTargetDur * 3 * 1000;
          if (isHls && onLiveProxy && lastManifestEdgeEpochMs && lastManifestFetchedAt
              && reportedDur > 5 && timePos > 1
              && (!playbackAnchor || playbackAnchor.path !== mpvPath?.data)) {
            const liveEdgeNow = lastManifestEdgeEpochMs + (Date.now() - lastManifestFetchedAt);
            const behindNow = Math.max(0, reportedDur - timePos);
            playbackAnchor = {
              path: mpvPath.data,
              mpvPosAtAnchor: timePos,
              userPdtAtAnchor: liveEdgeNow - behindNow * 1000 - MPV_DISPLAY_LAG_MS,
            };
          }
          // Invalidate playbackAnchor when mpv is no longer on the live
          // proxy (swapped to sub-proxy or something else).
          if (playbackAnchor && !onLiveProxy) playbackAnchor = null;

          // ── Scrubber position ────────────────────────────────────
          let scrubPos = timePos;
          let scrubDur = reportedDur > 0 ? reportedDur : histDur;
          let userPdt = null;
          // Gate the HLS scrubber block on proxy-URL presence alone, not
          // on `isHls` (which reads mpv's file-format property — transiently
          // empty during a `loadfile`, including between sub-proxy scrubs
          // and sub→live swaps). When that happens we'd fall out of this
          // block, `scrubPos` stays at raw `timePos` (= 0 just after
          // loadfile) and `scrubDur` at `histDur` (= 0 for fresh live),
          // and the client sees position=0 / duration=0 → scrubber thumb
          // snaps to the left edge for a tick.
          if (lastManifestFullDuration > 0 && (onLiveProxy || onSubProxy)) {
            scrubDur = lastManifestFullDuration;
            const liveEdgeNow = lastManifestEdgeEpochMs ? lastManifestEdgeEpochMs + (Date.now() - lastManifestFetchedAt) : null;
            if (onLiveProxy && playbackAnchor) {
              userPdt = playbackAnchor.userPdtAtAnchor + (timePos - playbackAnchor.mpvPosAtAnchor) * 1000;
            } else if (onSubProxy && subProxyAnchor && subProxyAnchor.mpvPosAtAnchor != null && subProxyAnchor.userPdtAtAnchor != null) {
              // Sub-proxy: userPdt advances purely from mpv's own
              // time-pos progress since anchor. Does NOT re-derive from
              // liveEdgeNow (which jitters ~1s on each manifest
              // refresh — phone sync was chasing every jump).
              //
              //   userPdt = userPdtAtAnchor + (mpv_pos_now - mpvPosAtAnchor) * 1000
              //
              // This is stable against manifest-refresh jitter. Pauses
              // freeze userPdt (mpv_pos stops advancing). 1x playback
              // makes userPdt advance at 1x. Phone tracks cleanly.
              userPdt = subProxyAnchor.userPdtAtAnchor + (timePos - subProxyAnchor.mpvPosAtAnchor) * 1000;
            } else if (liveEdgeNow) {
              // Transient fallback before any anchor is established.
              // Sub-proxy forces `live_start_index=0`, bypassing ffmpeg's
              // default -3 safety margin, so MPV_DISPLAY_LAG_MS doesn't
              // apply there — subtracting it would misreport behindLive
              // by the lag amount (typically 6-15s) on reconnect, when
              // no anchor is available yet.
              const lagMs = onSubProxy ? 0 : MPV_DISPLAY_LAG_MS;
              userPdt = liveEdgeNow - Math.max(0, reportedDur - timePos) * 1000 - lagMs;
            }
            if (userPdt != null && liveEdgeNow) {
              const behindLiveSec = Math.max(0, (liveEdgeNow - userPdt) / 1000);
              scrubPos = Math.max(0, Math.min(scrubDur, scrubDur - behindLiveSec));
            }
            // Drift debug log — opt-in via DEBUG_DRIFT=1. At 1Hz this
            // was writing to stdout every tick forever, bloating logs
            // and adding small but real event-loop jitter.
            if (process.env.DEBUG_DRIFT) {
              const mode = onSubProxy ? 'sub' : (onLiveProxy ? 'live' : 'other');
              const userPdtStr = userPdt ? new Date(userPdt).toISOString().substring(11, 23) : 'null';
              console.log(`[drift] ${mode} pos=${timePos.toFixed(2)} dur=${reportedDur.toFixed(1)} userPdt=${userPdtStr}`);
            }
          }

          // ── Phone PDT sync ───────────────────────────────────────
          // absoluteMs = wall-clock of the content frame mpv is showing.
          // Phone's AVPlayerItem.currentDate() returns the same for the
          // frame it's showing. drift = mpv_pdt - phone_pdt.
          const mpvAbsoluteMs = userPdt != null ? userPdt + syncOffsetMs : null;
          // isLive (and phoneSyncOk) need proxy-URL presence ORed in:
          // mpv's file-format property is transiently empty right after
          // a `loadfile` (sub-proxy scrub), briefly flipping isHls to
          // false and making the UI show the raw position as a timecode
          // instead of "-mm:ss" behind-live. If we're on one of our own
          // proxy URLs, it's definitionally HLS regardless of what mpv
          // has gotten around to reporting.
          const effectiveIsLive = isHls || onLiveProxy || onSubProxy;
          state = {
            type: "playback",
            playing: true, isLive: effectiveIsLive, player: "mpv",
            dvrActive,
            position: scrubPos,
            duration: scrubDur,
            paused: pause?.data || false,
            phoneSyncOk: !effectiveIsLive || !!mpvAbsoluteMs,
            absoluteMs: mpvAbsoluteMs,
            url: nowPlaying, serverTs: Date.now(),
            title: (() => {
              const t = historyMap.get(nowPlaying)?.title || "";
              return /\.m3u8($|\?)/.test(t) ? "" : t;
            })(),
            channel: historyMap.get(nowPlaying)?.channel || "",
            thumbnail: historyMap.get(nowPlaying)?.thumbnail || "",
            monitor: currentMonitor, windowMode: windowMode || "floating",
            visible: !phoneActive && !(pause?.data && windowMode !== "fullscreen"),
            height: _mpvVideoInfoCache.height,
            videoCodec: _mpvVideoInfoCache.videoCodec,
            hwdec: _mpvVideoInfoCache.hwdec,
            speed: speedR?.data ?? 1,
            syncOffsetMs,
          };
        } catch {
          state = { type: "playback", playing: false };
        }
      } else {
        state = { type: "playback", playing: false };
      }
      state.macStatus = _macStatusCache;
      state.claudeState = claudeState;
      if (claudeOptions.length) state.claudeOptions = claudeOptions;
      if (claudeQuestion) state.claudeQuestion = claudeQuestion;
      // tmuxWindows updated on its own 3s timer — read from cache here.
      if (tmuxWindows.length > 1) state.tmuxWindows = tmuxWindows;
      const msg = JSON.stringify(state);
      wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
    } catch {}
  }, 1000); // 1x per second
}

httpServer.listen(PORT, "0.0.0.0", async () => {
  startWsSync();
  console.log(`YouTubeCtrl running at http://localhost:${PORT}`);
  if (!API_KEY) console.warn("  WARNING: YOUTUBE_API_KEY not set in .env");
  if (!CLIENT_ID) console.warn("  WARNING: GOOGLE_CLIENT_ID not set in .env");
  await exportCookies();
  const nets = require("os").networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) {
      if (cfg.family === "IPv4" && !cfg.internal) {
        console.log(`  Phone: http://${cfg.address}:${PORT}`);
      }
    }
  }

  // Detect existing players from a previous server session
  // Check mpv
  try {
    const r = await mpvCommand(["get_property", "path"]);
    if (r?.data) {
      const url = r.data.startsWith("http") ? r.data : null;
      // mpv might have a YouTube URL, a direct stream URL, or one of
      // our own proxy URLs (if it was mid-DVR-scrub when server died).
      // For proxy paths we can't recover the YouTube URL — bail out;
      // user will /api/play fresh. Setting nowPlaying to the proxy URL
      // breaks things downstream (yt-dlp tries to fetch the proxy).
      if (url && (url.includes("/api/hls-live.m3u8") || url.includes("/api/hls-sub.m3u8") || url.includes("/api/hls-vod.m3u8"))) {
        // Proxy path — we need the YouTube URL separately. Preferred
        // source: persisted .now-playing.json. Fallback: the most
        // recent history entry (live streams are almost always the
        // freshest entry, so history[0] is a decent guess when the
        // persisted file is missing — e.g. first restart after this
        // feature shipped).
        if (nowPlaying && /youtube\.com\/watch\?v=/.test(nowPlaying)) {
          // keep already-loaded value
        } else if (history[0]?.url && /youtube\.com\/watch\?v=/.test(history[0].url)) {
          nowPlaying = history[0].url;
          console.log("  Recovered nowPlaying from history[0]:", nowPlaying);
        } else {
          nowPlaying = null;
        }
      } else if (url) {
        const m = url.match(/v=([\w-]+)/);
        nowPlaying = m ? `https://www.youtube.com/watch?v=${m[1]}` : url;
      } else {
        // Try media-title to find the URL in history
        const t = await mpvCommand(["get_property", "media-title"]);
        const entry = history.find(h => h.title === t?.data);
        if (entry) nowPlaying = entry.url;
      }
      if (nowPlaying) {
        mpvProcess = { kill: () => { try { execSync("pkill -x mpv", { stdio: "ignore" }); } catch {} } };
        activePlayer = "mpv";
        // Detect window mode
        const fs = await mpvCommand(["get_property", "fullscreen"]).catch(() => ({ data: false }));
        if (fs?.data) {
          windowMode = "fullscreen";
        } else {
          // Check if mpv fills screen (aerospace maximize = no outer gaps fullscreen)
          try {
            const size = execSync(`osascript -e 'tell application "System Events" to get size of first window of process "mpv"'`, { encoding: "utf8" }).trim();
            const [w] = size.split(", ").map(Number);
            const screenW = parseInt(execSync(`system_profiler SPDisplaysDataType | grep Resolution | head -1 | grep -oE '[0-9]+'`, { encoding: "utf8" }).trim());
            windowMode = (w >= screenW - 100) ? "maximize" : "floating";
          } catch {
            windowMode = "floating";
          }
        }
        // Detect which monitor mpv is on
        try {
          const posStr = execSync(`osascript -e 'tell application "System Events" to get position of first window of process "mpv"'`, { encoding: "utf8" }).trim();
          const [wx] = posStr.split(", ").map(Number);
          const screens = getScreenOrigins();
          const onScreen = screens.find(s => wx >= s.x && wx < s.x + s.w);
          currentMonitor = (onScreen?.isLaptop) ? "laptop" : "lg";
        } catch {}
        // Update title if missing in history. Prefer mpv's media-title,
        // but reject proxy pathnames (live stream playing our hls-live.m3u8
        // or hls-sub.m3u8 proxy reports the URL segment as the title).
        // When mpv's title is unusable, fetch the real one from YouTube
        // by video id — that's what the user sees in the now-playing bar,
        // and leaving it blank renders "Untitled" which is worse than
        // being slightly slow to reconnect.
        try {
          const t = await mpvCommand(["get_property", "media-title"]);
          const mpvTitle = t?.data;
          const looksLikeProxy = typeof mpvTitle === "string" && /\.m3u8($|\?)/.test(mpvTitle);
          const entry = historyMap.get(nowPlaying);
          const needsTitle = !entry || !entry.title;
          // If history already has a real title, pin mpv's media-title
          // to it now so any future reads don't fall back to the proxy
          // basename (hls-live.m3u8) for live streams.
          if (entry?.title && !/\.m3u8($|\?)/.test(entry.title)) {
            setMpvForceTitle(entry.title);
          }
          if (mpvTitle && !looksLikeProxy) {
            if (entry && needsTitle) { entry.title = mpvTitle; saveHistory(); }
            if (!entry) addToHistory(nowPlaying, mpvTitle, "");
          } else if (needsTitle) {
            // Fetch real title async so reconnect isn't blocked on the network call
            const idMatch = nowPlaying.match(/v=([\w-]+)/);
            if (idMatch) {
              (async () => {
                try {
                  const v = await YouTube.getVideo(`https://www.youtube.com/watch?v=${idMatch[1]}`);
                  if (v?.title) {
                    const cur = historyMap.get(nowPlaying);
                    if (cur) {
                      cur.title = v.title;
                      if (v.channel?.name && !cur.channel) cur.channel = v.channel.name;
                      if (v.thumbnail?.url && !cur.thumbnail) cur.thumbnail = v.thumbnail.url;
                      saveHistory();
                    } else {
                      addToHistory(nowPlaying, v.title, v.channel?.name || "", v.thumbnail?.url || "");
                    }
                    setMpvForceTitle(v.title);
                  }
                } catch (e) { console.error("Reconnect title fetch failed:", e.message); }
              })();
            }
          }
        } catch {}
        console.log("  Reconnected to mpv:", nowPlaying.substring(0, 60), "mode:", windowMode, "monitor:", currentMonitor);
        await mpvCommand(["set_property", "vid", "auto"]).catch(() => {}); // restore video if phone mode hid it
        // If reconnected to a live HLS stream, re-resolve the HLS URL and
        // kick off PDT tracking so phone sync works after server restart.
        try {
          const fmt = await mpvCommand(["get_property", "file-format"]).catch(() => null);
          if ((fmt?.data || "").includes("hls") && nowPlaying.startsWith("https://www.youtube.com/")) {
            (async () => {
              try {
                const { stdout } = await execFileP(
                  "yt-dlp", ["--cookies", COOKIES_FILE, "-f", "301/300/96/95/94/93", "--get-url", nowPlaying],
                  { timeout: 15000 }
                );
                currentLiveHlsUrl = stdout.trim();
                startMpvPdtTracking(currentLiveHlsUrl);
                // Prime manifest stats so the synth-anchor below has
                // live-edge info to reference.
                try {
                  const m = await fetchManifest(currentLiveHlsUrl);
                  updateManifestStatsFromText(m);
                } catch {}
                // If mpv is mid-DVR-scrub (on the sub-proxy), synthesize
                // a subProxyAnchor from mpv's current cache state. Without
                // this we'd rely on the no-anchor fallback for
                // behindLive, which is fine steady-state but shows a
                // wrong value for the first tick or two after reconnect
                // (and can flicker if the cache hasn't fully settled).
                const pathR = await mpvCommand(["get_property", "path"]).catch(() => null);
                if (pathR?.data?.includes("/api/hls-sub.m3u8") && lastManifestEdgeEpochMs) {
                  const [dur, pos] = await Promise.all([
                    mpvCommand(["get_property", "duration"]).catch(() => null),
                    mpvCommand(["get_property", "time-pos"]).catch(() => null),
                  ]);
                  const reportedDur = dur?.data || 0;
                  const timePos = pos?.data || 0;
                  if (reportedDur > 1 && timePos >= 0) {
                    const liveEdgeNow = lastManifestEdgeEpochMs + (Date.now() - lastManifestFetchedAt);
                    const behindLive = Math.max(0, reportedDur - timePos);
                    const userPdtAtAnchor = liveEdgeNow - behindLive * 1000;
                    subProxyAnchor = {
                      wallMs: Date.now(),
                      mpvPosAtAnchor: timePos,
                      behindLive,
                      userPdtAtAnchor,
                    };
                    console.log("  Synthesized subProxyAnchor on reconnect: behindLive=", behindLive.toFixed(1), "s");
                  }
                }
              } catch (e) { console.error("  reconnect PDT resolve failed:", e.message); }
            })();
          }
        } catch {}
        // Start progress tracking for reconnected player
        startProgressTracking(nowPlaying);
        // Monitor mpv liveness — if IPC fails, clean up state
        const mpvMonitor = setInterval(async () => {
          try { await mpvCommand(["get_property", "pid"]); }
          catch { clearInterval(mpvMonitor); progressGen++; if (progressInterval) { clearInterval(progressInterval); progressInterval = null; } mpvProcess = null; nowPlaying = null; activePlayer = null; stopMpvPdtTracking(); }
        }, 5000);
      }
    }
  } catch {}

});
