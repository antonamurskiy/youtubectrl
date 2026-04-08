require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const { execFile, execSync, spawn } = require("child_process");
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
    for (const h of history) historyMap.set(h.url, h);
  }
} catch (err) { console.error("Failed to load history:", err.message); }

let _saveHistoryTimer = null;
function saveHistory() {
  // Debounce writes to avoid blocking event loop on rapid updates
  if (_saveHistoryTimer) return;
  _saveHistoryTimer = setTimeout(() => {
    _saveHistoryTimer = null;
    fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), () => {});
  }, 500);
}

function markWatchedOnYouTube(url) {
  require("child_process").execFile("yt-dlp", [
    "--mark-watched", "--simulate", "--cookies", COOKIES_FILE, "--no-warnings", url,
  ], { timeout: 15000 }, () => {});
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

function addToHistory(url, title, channel) {
  const existing = historyMap.get(url);
  if (existing) {
    existing.timestamp = Date.now();
    if (title) existing.title = title;
    if (channel) existing.channel = channel;
    history = [existing, ...history.filter((h) => h.url !== url)];
  } else {
    const entry = { url, title, channel: channel || "", timestamp: Date.now(), position: 0, duration: 0 };
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

app.get("/api/audio-outputs", (_req, res) => {
  try {
    const all = execSync("SwitchAudioSource -a -t output", { encoding: "utf8" }).trim().split("\n");
    const current = execSync("SwitchAudioSource -c -t output", { encoding: "utf8" }).trim();
    res.json({ outputs: all, current });
  } catch { res.json({ outputs: [], current: "" }); }
});

app.post("/api/audio-output", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Missing name" });
  try {
    execSync(`SwitchAudioSource -s "${name.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Switch failed" }); }
});

app.post("/api/toggle-visibility", async (_req, res) => {
  try {
    if (activePlayer === "mpv") {
      phoneActive = !phoneActive;
      if (phoneActive) {
        execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to false'`, { stdio: "ignore" });
      } else {
        execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to true'`, { stdio: "ignore" });
        const wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
        if (wid) {
          execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" });
          if (windowMode === "maximize") execSync(`aerospace fullscreen --no-outer-gaps on --window-id ${wid}`, { stdio: "ignore" });
          else try { await mpvCommand(["set_property", "ontop", true]); } catch {}
        }
      }
    }
    res.json({ ok: true, visible: !phoneActive });
  } catch { res.status(500).json({ error: "Failed" }); }
});

app.post("/api/lock-mac", (_req, res) => {
  try {
    execSync(`pmset displaysleepnow`, { stdio: "ignore" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Lock failed" }); }
});

app.post("/api/focus-cmux", (_req, res) => {
  try {
    const front = execSync(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`, { encoding: "utf8", timeout: 2000 }).trim();
    if (front === "cmux") {
      // Return to mpv — restore previous window state
      phoneActive = false;
      execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to true'`, { stdio: "ignore" });
      const mpvWid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
      if (mpvWid) {
        execSync(`aerospace focus --window-id ${mpvWid}`, { stdio: "ignore" });
        if (windowMode === "maximize") {
          execSync(`aerospace fullscreen --no-outer-gaps on --window-id ${mpvWid}`, { stdio: "ignore" });
        } else if (windowMode === "floating") {
          try {
            const screens = getScreenOrigins();
            const posStr = execSync(`osascript -e 'tell application "System Events" to get position of first window of process "mpv"'`, { encoding: "utf8" }).trim();
            const [wx] = posStr.split(", ").map(Number);
            const screen = screens.find(s => wx >= s.x && wx < s.x + s.w) || screens.find(s => s.isMain) || screens[0];
            const w = Math.round(screen.w * 0.38);
            const h = Math.round(w * 9 / 16);
            const posX = screen.x + screen.w - w - 12;
            const posY = screen.y + 38;
            execSync(`osascript -e 'tell application "System Events" to tell process "mpv" to set size of first window to {${w}, ${h}}'`, { stdio: "ignore" });
            execSync(`osascript -e 'tell application "System Events" to tell process "mpv" to set position of first window to {${posX}, ${posY}}'`, { stdio: "ignore" });
          } catch {}
          try { mpvCommand(["set_property", "ontop", true]); } catch {}
        }
      }
    } else {
      // Focus cmux — pure AppleScript, no aerospace commands to avoid terminal reflow
      try {
        execSync(`osascript -e 'tell application "System Events" to set frontmost of process "cmux" to true'`, { stdio: "ignore" });
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

// Video preview URL — low quality stream for thumbnail preview
const previewCache = new Map();
app.get("/api/preview-url", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.json({ url: null });
  if (previewCache.has(id)) return res.json({ url: previewCache.get(id) });
  try {
    const { stdout } = await execFileP("yt-dlp", [
      "--cookies", COOKIES_FILE, "-f", "134/133/160/18",
      "--get-url", `https://www.youtube.com/watch?v=${id}`,
    ], { timeout: 10000 });
    const url = stdout.trim();
    if (url) previewCache.set(id, url);
    // Cap cache at 50 entries
    if (previewCache.size > 50) {
      const first = previewCache.keys().next().value;
      previewCache.delete(first);
    }
    res.json({ url: url || null });
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
    const { stdout } = await execFileP("yt-dlp", [
      "--cookies", COOKIES_FILE, "--flat-playlist", "--dump-json", "--no-warnings",
      "-I", "1:30", url,
    ], { timeout: 20000, maxBuffer: 10 * 1024 * 1024 });
    const videos = stdout.trim().split("\n").filter(Boolean).map(line => {
      const v = JSON.parse(line);
      return {
        id: v.id, title: v.title,
        thumbnail: v.thumbnails?.[v.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        duration: v.duration_string || (v.duration ? fmtSecs(v.duration) : ""),
        channel: v.channel || v.uploader,
        views: v.view_count || 0,
        url: `https://www.youtube.com/watch?v=${v.id}`,
      };
    });
    // Enrich with YouTube Data API for dates
    const ids = videos.map(v => v.id).filter(Boolean);
    if (ids.length) {
      try {
        const token = await getAccessToken();
        const enriched = await enrichVideos(ids, token);
        const enrichMap = Object.fromEntries(enriched.map(v => [v.id, v]));
        for (const v of videos) {
          const e = enrichMap[v.id];
          if (e) {
            v.duration = e.duration || v.duration;
            v.views = e.views || v.views;
            v.uploadedAt = e.uploadedAt || "";
            v.channelId = e.channelId || "";
            if (e.live) v.live = true;
          }
        }
      } catch {}
    }
    res.json({ videos });
  } catch (err) {
    console.error("Channel fetch failed:", err.message);
    res.json({ videos: [] });
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
  let nextContinuation = null;
  function extract(obj, depth) {
    if (depth > 30) return;
    if (typeof obj !== "object" || !obj) return;
    if (Array.isArray(obj)) { obj.forEach(i => extract(i, depth + 1)); return; }
    if (obj.continuationItemRenderer) {
      nextContinuation = obj.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || null;
      return;
    }
    if (obj.richItemRenderer?.content?.videoRenderer) {
      const vr = obj.richItemRenderer.content.videoRenderer;
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
      videos.push({
        id: vr.videoId, title: vr.title?.runs?.[0]?.text || "",
        thumbnail: bestThumb,
        duration: durText,
        channel: vr.shortBylineText?.runs?.[0]?.text || "",
        views: parseInt((vr.viewCountText?.simpleText?.match(/[\d,]+/) || ["0"])[0].replace(/,/g, "")) || 0,
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
      });
      return;
    }
    if (obj.richItemRenderer?.content?.lockupViewModel) {
      const lv = obj.richItemRenderer.content.lockupViewModel;
      const id = lv.contentId || "";
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
        const scheduledText = allTexts.find(t => /scheduled/i.test(t)) || "";
        const isUpcoming = /waiting|scheduled/i.test(viewsText + scheduledText);
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
          videos.push({ id, title, channel, channelId, thumbnail: thumb, duration: isLive ? "LIVE" : (isUpcoming ? "SOON" : duration), views, uploadedAt, url: `https://www.youtube.com/watch?v=${id}`, live: isLive, upcoming: isUpcoming, concurrentViewers: isLive ? views : undefined });
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
  return { videos, shorts, hasMore: !!nextContinuation };
}

// Cache raw home feed so pagination doesn't re-fetch
let homeFeedCache = [];
let homeFeedType = null;
let recShortsCache = [];

app.get("/api/home", async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const feed = req.query.feed || 'home'; // 'home' (mixed), 'recommended', 'subscriptions'
  const pageSize = 24;
  try {
    // Recommended uses browse API with continuation for infinite scroll, falls back to yt-dlp
    if (feed === 'recommended') {
      // Always fetch fresh — browse API for initial, continuation for more
      if (page === 0 || homeFeedType !== feed) {
        recContinuation = null;
        try {
          const result = await browseRecommended();
          if (result.videos.length < 5) throw new Error("too few results");
          homeFeedCache = result.videos;
          recShortsCache = result.shorts || [];
        } catch {
          homeFeedCache = await getSingleFeed('recommended', 150);
          recContinuation = null;
        }
        homeFeedType = feed;
      }
      // Fetch continuations until we have enough videos for this page
      while (recContinuation && (page + 1) * pageSize > homeFeedCache.length) {
        try {
          const result = await browseRecommended(recContinuation);
          if (!result.videos.length) break;
          homeFeedCache = [...homeFeedCache, ...result.videos];
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
    const data = await fetchLiveStreams();
    res.json(data);
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
let vlcProcess = null;
let nowPlaying = null;
let windowMode = null; // 'fullscreen' | 'maximize' | 'floating' | null
let currentMonitor = "lg"; // tracked server-side, updated on move-monitor
let progressInterval = null;
let progressGen = 0; // generation counter to prevent overlapping intervals
let activePlayer = null; // 'mpv' | 'vlc' | null
let vlcPaused = false;
let vlcPausedAt = 0; // timestamp when VLC was paused (for DVR behind correction)
let vlcDvrWindow = 0; // last known DVR window size from get_length
let vlcDvrBehind = 0; // seconds behind live edge (0 = at live edge)
let lastVlcHlsUrl = null; // stored for fMP4 relay

const VLC_RC_PORT = 9091;
function vlcRC(cmd) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; client.destroy(); resolve(buf.trim()); } }, 1000);
    const client = net.createConnection(VLC_RC_PORT, "127.0.0.1", () => {
      client.write(cmd + "\n");
    });
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk;
      if (buf.includes("\n")) {
        if (!settled) { settled = true; clearTimeout(timer); client.destroy(); resolve(buf.trim()); }
      }
    });
    client.on("error", (err) => { if (!settled) { settled = true; clearTimeout(timer); client.destroy(); reject(err); } });
  });
}
async function vlcStatus() {
  // Sequential — VLC RC can't handle parallel TCP connections reliably
  const time = parseInt(await vlcRC("get_time")) || 0;
  const length = parseInt(await vlcRC("get_length")) || 0;
  const playing = (await vlcRC("is_playing")).trim() === "1";
  return { time, length, state: playing ? "playing" : "paused", fullscreen: false };
}
async function vlcSeek(val) { return vlcRC(`seek ${val}`); }
async function vlcPause() { return vlcRC("pause"); }
async function vlcCommand(cmd) { return vlcRC(cmd); }

function killVlc() {
  if (vlcProcess) { try { vlcProcess.kill("SIGKILL"); } catch {} vlcProcess = null; }
  try { execSync("pkill -f VLC", { stdio: "ignore" }); } catch {}
  vlcDvrWindow = 0; vlcDvrBehind = 0; vlcPausedAt = 0; vlcManifestLiveEdgeMs = 0; vlcManifestFetchedAt = 0; vlcManifestCalibOffset = 0;
  vlcTimeModel.lastInt = 0; vlcTimeModel.lastIntAt = 0; vlcTimeModel.prevInt = 0; vlcTimeModel.prevIntAt = 0;
}

function vlcAerospace(cmd) {
  const wid = execSync("aerospace list-windows --all | grep VLC | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
  if (!wid) return null;
  try { execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" }); } catch {}
  try { execSync(`aerospace ${cmd} --window-id ${wid}`, { stdio: "ignore" }); } catch {}
  return wid;
}

async function vlcFloatTopRight() {
  try {
    vlcAerospace("layout floating");
    await new Promise(r => setTimeout(r, 150));
    const screens = getScreenOrigins();
    const screen = screens.find(s => s.isMain) || screens[0];
    if (!screen) return;
    const w = Math.round(screen.w * 0.38);
    const h = Math.round(w * 9 / 16);
    execSync(`osascript -e 'tell application "System Events" to tell process "VLC" to set size of first window to {${w}, ${h}}'`, { stdio: "ignore" });
    // Read actual size (VLC may clamp to minimum)
    const sizeStr = execSync(`osascript -e 'tell application "System Events" to get size of first window of process "VLC"'`, { encoding: "utf8" }).trim();
    const actualW = parseInt(sizeStr.split(",")[0]);
    const x = screen.x + screen.w - actualW;
    const y = screen.y;
    execSync(`osascript -e 'tell application "System Events" to tell process "VLC" to set position of first window to {${x}, ${y}}'`, { stdio: "ignore" });
  } catch {}
}

function spawnVlc(hlsUrl) {
  lastVlcHlsUrl = hlsUrl;
  vlcPdtEpochMs = 0; // reset PDT cache for new stream
  killVlc();
  vlcProcess = spawn("/Applications/VLC.app/Contents/MacOS/VLC", [
    "--extraintf", "cli",
    "--rc-host", `127.0.0.1:${VLC_RC_PORT}`,
    "--no-video-title-show", "--no-fullscreen", "--video-on-top",
    "--network-caching", "1000",
    "--clock-jitter", "0",
    "--low-delay",
    hlsUrl,
  ], { stdio: "ignore" });
  vlcProcess.on("exit", () => { if (activePlayer === "vlc") { vlcProcess = null; activePlayer = null; } });
  activePlayer = "vlc";
  windowMode = null;
  vlcPaused = false;
  // Hide play queue sidebar after VLC window is ready
  const hideQueue = (attempts = 0) => {
    if (attempts > 5) return;
    try {
      // Check if queue pane is visible (3rd split view pane not collapsed)
      const state = execSync(`defaults read org.videolan.vlc "NSSplitView Subview Frames librarywindowsplitview"`, { encoding: "utf8" });
      // If the 3rd pane has width > 0 and isn't collapsed (YES), toggle it
      const panes = state.match(/"([^"]+)"/g) || [];
      if (panes.length >= 3) {
        const thirdPane = panes[2];
        // Format: "x, y, w, h, collapsed, ..."  — if not collapsed, click to hide
        if (!thirdPane.includes("YES")) {
          execSync(`osascript -e 'tell application "System Events" to tell process "VLC" to click menu item "Play Queue..." of menu "Window" of menu bar 1'`, { stdio: "ignore" });
        }
      }
    } catch {
      setTimeout(() => hideQueue(attempts + 1), 1000);
    }
  };
  // Wait for VLC window, then position + hide queue
  let fsResets = 0;
  const initVlc = (attempts = 0) => {
    if (attempts > 15) return;
    try {
      execSync(`osascript -e 'tell application "System Events" to get size of first window of process "VLC"'`, { encoding: "utf8" });
      // Force exit fullscreen if VLC restored to it
      try {
        const isFs = execSync(`osascript -e 'tell application "System Events" to get value of attribute "AXFullScreen" of first window of process "VLC"'`, { encoding: "utf8" }).trim();
        if (isFs === "true") {
          if (++fsResets > 3) { windowMode = "fullscreen"; return; }
          execSync(`osascript -e 'tell application "System Events" to tell process "VLC" to set value of attribute "AXFullScreen" of first window to false'`, { stdio: "ignore" });
          setTimeout(() => initVlc(0), 1200);
          return;
        }
      } catch {}
      hideQueue();
      vlcFloatTopRight();
      windowMode = "floating";
    } catch {
      setTimeout(() => initVlc(attempts + 1), 200);
    }
  };
  setTimeout(initVlc, 500);
  startVlcTimeModel();
  fetchPdtFromUrl(hlsUrl); // capture PDT from the same manifest VLC uses
  startDvrRefresh();
}

app.get("/api/now-playing", (_req, res) => {
  res.json({ url: nowPlaying });
});

function startProgressTracking(url) {
  if (progressInterval) clearInterval(progressInterval);
  const gen = ++progressGen;
  progressInterval = setInterval(async () => {
    if (gen !== progressGen) { clearInterval(progressInterval); return; }
    try {
      const [pos, dur] = await Promise.all([
        mpvCommand(["get_property", "time-pos"]),
        mpvCommand(["get_property", "duration"]),
      ]);
      if (gen !== progressGen) return;
      if (pos?.data && dur?.data && pos.data < dur.data * 1.05) updateHistoryProgress(url, pos.data, dur.data);
    } catch {}
  }, 10000);
}

let playLock = false;
app.post("/api/play", async (req, res) => {
  if (playLock) return res.json({ ok: true, queued: true });
  playLock = true;
  const { url, isLive: clientIsLive, title: reqTitle, channel: reqChannel, watchPct } = req.body;
  if (!url || !url.startsWith("https://www.youtube.com/")) {
    playLock = false;
    return res.status(400).json({ error: "Invalid URL" });
  }

  // Detect live streams server-side if frontend didn't flag it
  let isLive = clientIsLive;
  if (!isLive) {
    try {
      const { stdout } = await execFileP("yt-dlp", ["--cookies", COOKIES_FILE, "--print", "is_live", url], { timeout: 10000 });
      if (stdout.trim() === "True") isLive = true;
    } catch {}
  }

  try {
    // If live, use VLC for DVR support + phone sync
    if (isLive) {
      // Kill mpv if switching from VOD to live
      // Store HLS URL for VLC DVR switch later
      try {
        const { stdout } = await execFileP(
          "yt-dlp", ["--cookies", COOKIES_FILE, "-f", "301/300/96/95/94/93", "--get-url", url],
          { timeout: 15000 }
        );
        lastVlcHlsUrl = stdout.trim();
      } catch {}
      // Kill VLC if running — live streams now use mpv for precise time sync
      if (activePlayer === "vlc" && vlcProcess) { killVlc(); }
      // Fall through to mpv playback below
      isLive = false; // let mpv handle it as a regular stream
    }

    const savedEntry = historyMap.get(url);
    const pos = savedEntry?.position || 0;
    const dur = savedEntry?.duration || 0;
    const resumePos = pos > 0 && dur > 0 && pos < dur * 0.95 && pos < dur - 10 ? pos : 0;
    // Kill VLC if switching from live to VOD
    killVlc();

    // If mpv is already running, load new video in existing player
    if (mpvProcess) {
      try {
        // Verify mpv is actually responsive
        await mpvCommand(["get_property", "pid"]);
        // Save current video's progress before switching (with timeout)
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
        await mpvCommand(["loadfile", url, "replace"]);
        await mpvCommand(["set_property", "pause", false]).catch(() => {});
        await mpvCommand(["set_property", "vid", "auto"]).catch(() => {}); // restore video if phone mode hid it
        // Unhide if it was hidden from pause
        try { execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to true'`, { stdio: "ignore" }); } catch {}
        nowPlaying = url;
        addToHistory(url, reqTitle || "", reqChannel || "");
        // Reset position for this video to prevent stale data from corrupting resume
        const entry = historyMap.get(url);
        if (entry && resumePos <= 0) { entry.position = 0; entry.duration = 0; }
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
          // Seek to resume position, or compute from YouTube watch percentage
          try {
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
          } catch {}
          // Re-apply window mode in case loadfile disrupted it
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
            if (t?.data) { history[0].title = t.data; saveHistory(); }
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
    const mpvArgs = [`--input-ipc-server=/tmp/mpv-socket`, `--ytdl-raw-options=cookies=${COOKIES_FILE}`, `--hwdec=auto-safe`, `--keep-open`, `--demuxer-max-back-bytes=512M`, `--cache=yes`, `--audio-samplerate=48000`, `--autosync=30`];
    if (geometry) mpvArgs.push(`--geometry=${geometry}`, `--ontop`);
    if (windowMode === "fullscreen") mpvArgs.push(`--fs`);
    mpvArgs.push(url);
    if (resumePos > 0) mpvArgs.push(`--start=${Math.floor(resumePos)}`);
    else if (watchPct > 0 && watchPct < 95) mpvArgs.push(`--start=${Math.floor(watchPct)}%`);

    // Focus LG workspace so mpv spawns there
    try { execSync("aerospace workspace 1", { stdio: "ignore" }); } catch {}

    const child = spawn("mpv", mpvArgs, {
      stdio: "ignore",
    });

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
    addToHistory(url, reqTitle || "", reqChannel || "");

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
        if (t?.data) { history[0].title = t.data; saveHistory(); }
      } catch {}
      markWatchedOnYouTube(url);
      startProgressTracking(url);
    }, 5000);

    child.on("exit", async (code) => {
      progressGen++;
      if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
      if (mpvProcess === child) {
        // If mpv exited within 5 seconds, it probably failed — remove from history
        const elapsed = Date.now() - child._startTime;
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
  // Save final position before stopping
  if (activePlayer === "vlc") {
    killVlc();
    activePlayer = null;
    nowPlaying = null;
    return res.json({ ok: true });
  }
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
  res.json({ ok: true });
});

// IPC helper for mpv
function mpvCommand(cmd) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; client.destroy(); resolve(null); } }, 2000);
    const client = net.createConnection("/tmp/mpv-socket", () => {
      client.write(JSON.stringify({ command: cmd }) + "\n");
    });
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      for (const line of lines) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if ("request_id" in parsed) {
            if (!settled) { settled = true; clearTimeout(timer); client.destroy(); resolve(parsed); }
            return;
          }
        } catch {}
      }
    });
    client.on("error", (err) => { if (!settled) { settled = true; clearTimeout(timer); client.destroy(); reject(err); } });
  });
}

// Get playback position
app.get("/api/playback", async (_req, res) => {
  // VLC playback
  if (activePlayer === "vlc" && vlcProcess && nowPlaying) {
    try {
      const s = await vlcStatus();
      const monitor = currentMonitor;
      // vlcDvrWindow is set from the real YouTube manifest (not VLC's get_length which shrinks after trimmed reload)
      if (vlcDvrWindow <= 0 && s.length > 0) vlcDvrWindow = s.length; // fallback only if never set
      // DVR position: tracked server-side (VLC PTS is unreliable for live HLS)
      const dvrPos = Math.max(0, vlcDvrWindow - vlcDvrBehind);
      return res.json({
        playing: true,
        url: nowPlaying,
        position: dvrPos,
        duration: vlcDvrWindow,
        dvrWindow: vlcDvrWindow,
        title: historyMap.get(nowPlaying)?.title || "",
        channel: historyMap.get(nowPlaying)?.channel || "",
        paused: vlcPaused,
        fullscreen: windowMode === "fullscreen",
        isLive: true,
        windowMode: windowMode || "floating",
        monitor,
        player: "vlc",
      });
    } catch {
      return res.json({ playing: !!nowPlaying, url: nowPlaying, position: 0, duration: 0 });
    }
  }
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
let vlcSeekBusy = false;
app.post("/api/seek", async (req, res) => {
  const { position } = req.body;
  if (typeof position !== "number") return res.status(400).json({ error: "Invalid position" });
  try {
    if (activePlayer === "vlc") {
      if (vlcSeekBusy) { console.log("VLC seek SKIPPED (busy), position:", position); return res.json({ ok: true, skipped: true }); }
      vlcSeekBusy = true;
      // position is DVR-relative (0 = DVR start, dvrWindow = live edge)
      const targetBehind = Math.max(0, vlcDvrWindow - position);
      vlcDvrBehind = targetBehind;
      console.log(`VLC seek: pos=${position} behind=${targetBehind} dvrWin=${vlcDvrWindow}`);
      if (targetBehind < 2) {
        // Go live — reload original HLS URL
        vlcDvrBehind = 0;
        fs.writeFileSync("/tmp/vlc-next.m3u", lastVlcHlsUrl);
      } else {
        // Reload via proxy that trims segments from the end
        fs.writeFileSync("/tmp/vlc-next.m3u", "http://localhost:3000/api/vlc-hls-offset");
      }
      await vlcRC("clear");
      await vlcRC("add /tmp/vlc-next.m3u");
      // Reset time model — VLC PTS changes base after reload
      vlcTimeModel.lastInt = 0; vlcTimeModel.lastIntAt = 0; vlcTimeModel.prevInt = 0; vlcTimeModel.prevIntAt = 0;
      // Give VLC time to rebuffer before allowing next seek
      setTimeout(() => { vlcSeekBusy = false; }, 3000);
      return res.json({ ok: true });
    }
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
    if (activePlayer === "vlc") {
      // Use VLC's native seek for small offsets (no reload)
      await vlcRC(`seek ${offset > 0 ? '+' : ''}${offset}`);
      return res.json({ ok: true });
    }
    await mpvCommand(["seek", offset, "relative"]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Seek failed" });
  }
});

// Fetch HLS manifest helper
function fetchManifest(url) {
  const https = require('https');
  const http = require('http');
  const get = url.startsWith('https') ? https.get : http.get;
  return new Promise((resolve, reject) => {
    const req = get(url, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d));
    }).on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('fetchManifest timeout')); }, 5000);
  });
}

// Parse total duration from HLS manifest segments
function hlsTotalDuration(manifest) {
  let total = 0;
  for (const line of manifest.split('\n')) {
    if (line.startsWith('#EXTINF:')) total += parseFloat(line.split(':')[1]);
  }
  return total;
}

// Compute live edge PDT from manifest (last PDT + durations after it)
// Handles discontinuities where PDT resets mid-manifest
function hlsLiveEdgePdt(manifest) {
  const lines = manifest.split('\n');
  let lastPdtMs = 0;
  let durAfterLastPdt = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      lastPdtMs = new Date(line.substring('#EXT-X-PROGRAM-DATE-TIME:'.length).trim()).getTime();
      durAfterLastPdt = 0;
    } else if (line.startsWith('#EXTINF:')) {
      durAfterLastPdt += parseFloat(line.split(':')[1]);
    }
  }
  return lastPdtMs > 0 ? lastPdtMs + durAfterLastPdt * 1000 : 0;
}

// Refresh real DVR window from YouTube manifest periodically
let vlcDvrRefreshInterval = null;
function startDvrRefresh() {
  if (vlcDvrRefreshInterval) clearInterval(vlcDvrRefreshInterval);
  vlcDvrRefreshInterval = setInterval(async () => {
    if (!lastVlcHlsUrl || activePlayer !== "vlc") { clearInterval(vlcDvrRefreshInterval); vlcDvrRefreshInterval = null; return; }
    try {
      const m = await fetchManifest(lastVlcHlsUrl);
      const dur = hlsTotalDuration(m);
      if (dur > 0) vlcDvrWindow = dur;
      const liveEdge = hlsLiveEdgePdt(m);
      if (liveEdge > 0) {
        vlcManifestLiveEdgeMs = liveEdge; vlcManifestFetchedAt = Date.now();
        // Calibrate manifest-based time against accurate PDT+vlcTime while at live edge
        if (vlcPdtEpochMs && vlcDvrBehind < 2 && vlcTimeNow() > 0) {
          const pdtAbsMs = vlcPdtEpochMs + vlcTimeNow() * 1000;
          vlcManifestCalibOffset = pdtAbsMs - liveEdge;
        }
      }
    } catch {}
  }, 5000);
}

// HLS proxy for DVR seeking — serves playlist with segments trimmed from end
app.get("/api/vlc-hls-offset", async (_req, res) => {
  if (!lastVlcHlsUrl) return res.status(400).send("No HLS URL");
  try {
    const manifest = await fetchManifest(lastVlcHlsUrl);
    // Update real DVR window from manifest
    const realDvr = hlsTotalDuration(manifest);
    if (realDvr > 0) vlcDvrWindow = realDvr;
    if (vlcDvrBehind <= 0) {
      return res.type('application/vnd.apple.mpegurl').send(manifest);
    }
    // Parse segments and trim the last N seconds worth
    const lines = manifest.split('\n');
    const segLines = []; // [{idx, dur}]
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXTINF:')) {
        segLines.push({ idx: i, dur: parseFloat(lines[i].split(':')[1]) });
      }
    }
    // Remove segments from the end to cover vlcDvrBehind seconds
    let trimDur = 0;
    let trimFrom = segLines.length;
    for (let i = segLines.length - 1; i >= 0; i--) {
      trimDur += segLines[i].dur;
      if (trimDur >= vlcDvrBehind) { trimFrom = i; break; }
    }
    // Keep lines up to (but not including) the first trimmed segment's #EXTINF line
    const cutAt = trimFrom < segLines.length ? segLines[trimFrom].idx : lines.length;
    const trimmed = lines.slice(0, cutAt).join('\n');
    res.type('application/vnd.apple.mpegurl').send(trimmed);
  } catch (e) {
    res.status(500).send("Proxy error: " + e.message);
  }
});

// Lightweight HLS proxy for phone — only last 30s of segments (full manifest is 5MB+)
app.get("/api/phone-hls", async (req, res) => {
  if (!lastVlcHlsUrl) return res.status(400).send("No HLS URL");
  try {
    const manifest = await fetchManifest(lastVlcHlsUrl);
    const lines = manifest.split('\n');
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
    // Trim from end based on vlcDvrBehind, then keep ~120s window
    // This makes the phone manifest match VLC's DVR position
    let trimEnd = segLines.length;
    if (vlcDvrBehind > 2) {
      let trimDur = 0;
      for (let i = segLines.length - 1; i >= 0; i--) {
        trimDur += segLines[i].dur;
        trimEnd = i;
        if (trimDur >= vlcDvrBehind) break;
      }
    }
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

// VLC absolute time via HLS PDT — for phone sync
let vlcPdtEpochMs = 0;
let syncOffsetMs = 0; // tunable offset for drift calibration (milliseconds)
app.post("/api/sync-offset", (req, res) => { syncOffsetMs = (req.body.ms || 0); console.log("  Sync offset:", syncOffsetMs, "ms"); res.json({ ok: true, ms: syncOffsetMs }); });
app.get("/api/sync-offset", (_req, res) => { res.json({ ms: syncOffsetMs }); });
let vlcManifestLiveEdgeMs = 0; // PDT of last segment in manifest (= live edge content time)
let vlcManifestFetchedAt = 0; // wall-clock when manifest was last fetched
let vlcManifestCalibOffset = 0; // offset between PDT-based and manifest-based absolute time (calibrated at live edge)
// Fetch PDT from an HLS URL (called once at VLC spawn)
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

async function fetchPdtFromUrl(hlsUrl) {
  try {
    const manifest = await fetchManifest(hlsUrl);
    const lines = manifest.split('\n');
    const pdtMatch = manifest.match(/#EXT-X-PROGRAM-DATE-TIME:(.+)/);
    const seqMatch = manifest.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    if (!pdtMatch) return;
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
        // Fetch first 10KB of segment and extract PTS from MPEG-TS
        const segBuf = await fetchHead(segUrl, 10240);
        const segPts = extractFirstPts(segBuf);
        if (segPts !== null) {
          // Precise mapping: segment's PDT corresponds to segment's PTS
          // vlcPdtEpochMs = PDT_of_segment - PTS_of_segment (in ms)
          // Then: vlcDisplayTime = vlcPdtEpochMs + vlcGetTime * 1000
          vlcPdtEpochMs = pdtMs - segPts * 1000;
          console.log(`  PDT (PTS): seq=${mediaSeq} segPTS=${segPts.toFixed(1)}s → streamStart=${new Date(vlcPdtEpochMs).toISOString()}`);
          return;
        }
      } catch (e) { console.error("  PTS extraction failed:", e.message); }
    }

    // Fallback: imprecise avgSegDuration method
    let totalDur = 0, count = 0;
    lines.filter(l => l.startsWith('#EXTINF')).forEach(l => { totalDur += parseFloat(l.split(':')[1]); count++; });
    const avgSeg = count > 0 ? totalDur / count : 5;
    vlcPdtEpochMs = pdtMs - mediaSeq * avgSeg * 1000;
    console.log(`  PDT (fallback): seq=${mediaSeq} avgSeg=${avgSeg.toFixed(1)}s → streamStart=${new Date(vlcPdtEpochMs).toISOString()}`);
  } catch (e) { console.error("fetchPdt error:", e.message); }
}
app.get("/api/vlc-absolute-time", async (_req, res) => {
  if (activePlayer !== "vlc") return res.json({});
  // Suppress during DVR seek reloads — VLC is rebuffering, drift would be wrong
  if (vlcSeekBusy) return res.json({});
  try {
    if (!vlcPdtEpochMs && vlcDvrBehind < 2) {
      // No PDT calibration (reconnected VLC) and at live edge — can't compute absolute time
      return res.json({});
    }
    if (vlcDvrBehind < 2 && vlcPdtEpochMs) {
      // At live edge with PDT: use original PDT + vlcTime (accurate, accounts for VLC buffering)
      const absoluteMs = vlcPdtEpochMs + vlcTimeNow() * 1000;
      return res.json({ absoluteMs, vlcTime: vlcTimeNow(), pdtEpoch: vlcPdtEpochMs });
    }
    // Behind live (after DVR seek): manifest-based (VLC PTS is unreliable after reload)
    if (vlcManifestLiveEdgeMs > 0) {
      const liveEdgeNow = vlcManifestLiveEdgeMs + (Date.now() - vlcManifestFetchedAt);
      const absoluteMs = liveEdgeNow - vlcDvrBehind * 1000;
      return res.json({ absoluteMs, vlcTime: vlcTimeNow(), pdtEpoch: vlcPdtEpochMs });
    }
    return res.json({});
  } catch {
    res.json({});
  }
});

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

app.post("/api/vlc-rate", async (req, res) => {
  const { rate } = req.body;
  if (typeof rate !== "number" || rate < 0.5 || rate > 2.0) return res.status(400).json({ error: "Invalid rate" });
  if (activePlayer !== "vlc") return res.status(400).json({ error: "VLC not active" });
  try {
    await vlcRC(`rate ${rate}`);
    res.json({ ok: true, rate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Switch live stream from mpv to VLC for DVR scrubbing
app.post("/api/switch-to-vlc", async (_req, res) => {
  if (!nowPlaying || !lastVlcHlsUrl) return res.status(400).json({ error: "No live stream" });
  // Get current mpv position for resume
  let pos = 0;
  try { const p = await mpvCommand(["get_property", "time-pos"]); pos = p?.data || 0; } catch {}
  // Kill mpv
  if (mpvProcess) { try { mpvProcess.kill("SIGKILL"); } catch {} mpvProcess = null; }
  if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
  // Start VLC
  spawnVlc(lastVlcHlsUrl);
  activePlayer = "vlc";
  res.json({ ok: true, player: "vlc" });
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
    const videos = await getYouTubeHistory(token);
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
      for (const v of videos) {
        const h = historyMap.get(v.url);
        if (h?.position > 0 && h?.duration > 0) {
          v.savedPosition = h.position;
          v.savedDuration = h.duration;
        }
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
      id: m ? m[1] : "",
      title: h.title || h.url,
      thumbnail: m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : "",
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

// Watch on phone — pause mpv, return YouTube URL at current timestamp
// Volume control
app.get("/api/volume", (_req, res) => {
  try {
    const vol = execSync(`osascript -e 'output volume of (get volume settings)'`, { encoding: "utf8" }).trim();
    const muted = execSync(`osascript -e 'output muted of (get volume settings)'`, { encoding: "utf8" }).trim() === "true";
    res.json({ volume: parseInt(vol), muted });
  } catch {
    res.json({ volume: 50, muted: false });
  }
});

app.post("/api/volume", (req, res) => {
  const vol = parseInt(req.body.volume);
  if (isNaN(vol) || vol < 0 || vol > 100) return res.status(400).json({ error: "Invalid volume" });
  try {
    execSync(`osascript -e 'set volume output volume ${vol}'`, { stdio: "ignore" });
    res.json({ ok: true });
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
app.get("/api/volume-status", (_req, res) => {
  try {
    const muteState = execSync(`osascript -e 'output muted of (get volume settings)'`, { encoding: "utf8" }).trim();
    const vol = execSync(`osascript -e 'output volume of (get volume settings)'`, { encoding: "utf8" }).trim();
    res.json({ muted: muteState === "true", volume: parseInt(vol) || 0 });
  } catch { res.json({ muted: false, volume: 50 }); }
});

app.post("/api/mute", (_req, res) => {
  try {
    const muteState = execSync(`osascript -e 'output muted of (get volume settings)'`, { encoding: "utf8" }).trim();
    const isMuted = muteState === "true";
    execSync(`osascript -e 'set volume output muted ${isMuted ? "false" : "true"}'`, { stdio: "ignore" });
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

// VLC time interpolation — sub-second precision from integer get_time
let vlcTimeModel = { lastInt: 0, lastIntAt: 0, prevInt: 0, prevIntAt: 0, running: false };

function startVlcTimeModel() {
  if (vlcTimeModel.running) { console.log("vlcTimeModel already running"); return; }
  console.log("Starting vlcTimeModel");
  vlcTimeModel.running = true;
  let lastRaw = 0;
  const poll = async () => {
    if (!vlcTimeModel.running || activePlayer !== "vlc") { console.log("vlcTimeModel stopped:", vlcTimeModel.running, activePlayer); vlcTimeModel.running = false; return; }
    try {
      const raw = await vlcRC("get_time").then(s => parseInt(s) || 0);
      const now = Date.now();
      if (raw !== lastRaw && raw > 0) {
        // Integer just changed — record the transition
        vlcTimeModel.prevInt = vlcTimeModel.lastInt;
        vlcTimeModel.prevIntAt = vlcTimeModel.lastIntAt;
        vlcTimeModel.lastInt = raw;
        vlcTimeModel.lastIntAt = now;
      }
      lastRaw = raw;
    } catch {}
    setTimeout(poll, 1000);
  };
  poll();
}

function vlcTimeNow() {
  if (!vlcTimeModel.lastIntAt) return 0;
  const elapsed = (Date.now() - vlcTimeModel.lastIntAt) / 1000;
  return vlcTimeModel.lastInt + elapsed;
}

app.get("/api/phone-sync-target", async (_req, res) => {
  if (activePlayer === "vlc" && vlcTimeModel.lastIntAt) {
    return res.json({ vlcTime: vlcTimeNow(), serverTs: Date.now() });
  }
  if (activePlayer === "mpv" && mpvProcess) {
    try {
      const p = await mpvCommand(["get_property", "time-pos"]);
      if (p?.data) return res.json({ vlcTime: p.data, serverTs: Date.now() });
    } catch {}
  }
  res.json({});
});

// fMP4 relay — ffmpeg reads stream source, outputs fragmented MP4 for phone
let phoneFmp4Process = null;

app.get("/api/phone-live-stream", async (_req, res) => {
  // Stream directly from ffmpeg with Content-Length for Safari compatibility
  let streamUrl = lastVlcHlsUrl;
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
    if (activePlayer === "vlc") {
      try { const t = await vlcRC("get_time").then(s => parseInt(s) || 0); if (t > 5) ffArgs.push("-ss", String(t - 3)); } catch {}
    } else if (activePlayer === "mpv") {
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
let phoneSwitchedFromVlc = false; // track if we switched VLC→mpv for phone sync
let phoneActive = false; // phone sync is active — don't show mpv window on unpause
function killPhoneStream() {
  if (phoneFmp4Process) { try { phoneFmp4Process.kill("SIGKILL"); } catch {} phoneFmp4Process = null; }
}

app.post("/api/watch-on-phone", async (_req, res) => {
  if (!nowPlaying) return res.status(400).json({ error: "Nothing playing" });
  try {
    let seconds = 0;
    if (activePlayer === "vlc") {
      const s = await vlcStatus();
      seconds = s.time || 0;
    } else {
      const pos = await mpvCommand(["get_property", "time-pos"]);
      seconds = Math.floor(pos?.data || 0);
      // Hide mpv window when playing on phone (don't use vid=no, it can drop audio)
      try { execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to false'`, { stdio: "ignore" }); } catch {}
    }
    const m = nowPlaying.match(/v=([\w-]+)/);
    const videoId = m ? m[1] : "";

    if (activePlayer === "vlc") {
      // Switch VLC → mpv for phone sync (shouldn't happen since live now uses mpv)
      console.log("Phone sync: VLC active, switching to mpv");
      phoneSwitchedFromVlc = true;
      killVlc();
      try { execSync("pkill -9 mpv", { stdio: "ignore" }); } catch {}
      await new Promise(r => setTimeout(r, 200));
      try { fs.unlinkSync("/tmp/mpv-socket"); } catch {}
      mpvProcess = spawn("mpv", [
        `--input-ipc-server=/tmp/mpv-socket`, `--ytdl-raw-options=cookies=${COOKIES_FILE}`,
        `--hwdec=auto-safe`, `--keep-open`, `--cache=yes`, `--audio-samplerate=48000`, `--autosync=30`, nowPlaying,
      ], { stdio: "ignore" });
      activePlayer = "mpv";
      windowMode = "floating";
      await new Promise(r => setTimeout(r, 3000));
      try { const pos = await mpvCommand(["get_property", "time-pos"]); seconds = Math.floor(pos?.data || 0); } catch {}
    }
    if (activePlayer === "mpv") {
      phoneActive = true;
      try { execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to false'`, { stdio: "ignore" }); } catch {}
    }

    // VOD — direct URL (Safari plays these natively)
    const { stdout } = await execFileP(
      "yt-dlp", ["--cookies", COOKIES_FILE, "-f", "22/18/best[height<=720]", "--get-url", nowPlaying],
      { timeout: 15000 }
    );
    const streamUrl = stdout.trim().split("\n")[0];
    res.json({ streamUrl, seconds, videoId });
  } catch (err) {
    console.error("Watch on phone error:", err.message);
    try {
      const m = nowPlaying.match(/v=([\w-]+)/);
      let s = 0;
      if (activePlayer === "vlc") {
        const st = await vlcStatus().catch(() => ({ time: 0 }));
        s = st.time || 0;
      } else {
        const pos = await mpvCommand(["get_property", "time-pos"]).catch(() => ({ data: 0 }));
        s = Math.floor(pos?.data || 0);
      }
      res.json({ youtubeUrl: `https://youtu.be/${m?.[1]}?t=${s}`, seconds: s });
    } catch {
      res.status(500).json({ error: "Failed" });
    }
  }
});

app.post("/api/stop-phone-stream", async (_req, res) => {
  killPhoneStream();
  phoneSwitchedFromVlc = false;
  phoneActive = false;
  if (activePlayer === "mpv") {
    // VOD — restore mpv window
    try {
      execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to true'`, { stdio: "ignore" });
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
        "--extractor-args", "youtube:max_comments=20",
        "--write-comments", "--skip-download", "--dump-json",
        "--no-warnings",
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: 20000, maxBuffer: 5 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout);
    const comments = (data.comments || []).map((c) => ({
      author: c.author || "Unknown",
      text: c.text || "",
      likes: c.like_count || 0,
      publishedAt: c.timestamp ? timeAgo(new Date(c.timestamp * 1000).toISOString()) : "",
    }));
    res.json(comments);
  } catch (err) {
    console.error("Comments error:", err.message);
    res.json([]);
  }
});

// Play/pause
app.post("/api/playpause", async (_req, res) => {
  if (activePlayer === "vlc") {
    try {
      await vlcPause();
      vlcPaused = !vlcPaused;
      // Note: don't adjust vlcDvrBehind on pause/unpause — VLC's HLS demuxer
      // catches back up to live edge on its own after unpausing
      if (windowMode === "floating" || windowMode === "maximize") {
        try {
          if (vlcPaused) {
            execSync(`osascript -e 'tell application "System Events" to set visible of process "VLC" to false'`, { stdio: "ignore" });
          } else {
            execSync(`osascript -e 'tell application "System Events" to set visible of process "VLC" to true'`, { stdio: "ignore" });
            execSync(`osascript -e 'tell application "VLC" to activate'`, { stdio: "ignore" });
          }
        } catch {}
      }
      return res.json({ ok: true, paused: vlcPaused });
    } catch {
      return res.status(500).json({ error: "VLC play/pause failed" });
    }
  }
  try {
    await mpvCommand(["cycle", "pause"]);
    const state = await mpvCommand(["get_property", "pause"]);
    const paused = !!state?.data;
    // Hide/show window when pausing in floating/maximize mode
    if (windowMode === "floating" || windowMode === "maximize") {
      try {
        const wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
        if (paused) {
          execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to false'`, { stdio: "ignore" });
        } else if (!phoneActive) {
          execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to true'`, { stdio: "ignore" });
          if (wid && windowMode === "maximize") {
            execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" });
            execSync(`aerospace fullscreen --no-outer-gaps on --window-id ${wid}`, { stdio: "ignore" });
          }
        }
      } catch {}
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
    const appName = activePlayer === "vlc" ? "VLC" : "mpv";
    const wid = execSync(`aerospace list-windows --all | grep ${appName} | awk -F'|' '{print $1}' | tr -d ' ' | head -1`, { encoding: "utf8" }).trim();
    if (!wid) return res.status(400).json({ error: `No ${appName} window` });

    if (activePlayer === "vlc") {
      const targetWs = target === "laptop" ? "8" : "1";
      const savedMode = windowMode;
      if (windowMode === "fullscreen") {
        await vlcCommand("fullscreen");
        await new Promise(r => setTimeout(r, 500));
      }
      vlcAerospace("fullscreen off");
      execSync(`aerospace move-node-to-workspace --window-id ${wid} ${targetWs}`, { stdio: "ignore" });
      execSync(`aerospace workspace ${targetWs}`, { stdio: "ignore" });
      await new Promise(r => setTimeout(r, 300));
      if (savedMode === "fullscreen") {
        await vlcCommand("fullscreen");
        try { execSync(`osascript -e 'tell application "VLC" to activate'`, { stdio: "ignore" }); } catch {}
        windowMode = "fullscreen";
      } else if (savedMode === "maximize") {
        vlcAerospace("layout tiling");
        vlcAerospace("fullscreen --no-outer-gaps on");
        windowMode = "maximize";
      } else {
        windowMode = "floating";
      }
      currentMonitor = target;
      res.json({ ok: true });
      windowLock = false;
      return;
    }

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
    if (activePlayer === "vlc") {
      if (windowMode === "fullscreen") {
        await vlcCommand("fullscreen");
        await new Promise(r => setTimeout(r, 500));
      }
      if (windowMode === "maximize") {
        vlcAerospace("fullscreen off");
        await vlcFloatTopRight();
        windowMode = "floating";
      } else {
        vlcAerospace("layout tiling");
        vlcAerospace("fullscreen --no-outer-gaps on");
        windowMode = "maximize";
      }
      res.json({ ok: true });
      windowLock = false;
      return;
    }
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
      // Enter maximize — move to focused workspace first so it fullscreens on the right monitor
      try { await mpvCommand(["set_property", "ontop", false]); } catch {}
      try {
        const focusedWs = execSync("aerospace list-workspaces --focused", { encoding: "utf8" }).trim();
        execSync(`aerospace move-node-to-workspace --window-id ${wid} ${focusedWs}`, { stdio: "ignore" });
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
    if (activePlayer === "vlc") {
      if (windowMode === "maximize") {
        vlcAerospace("fullscreen off");
      }
      await vlcCommand("fullscreen");
      await new Promise(r => setTimeout(r, 500));
      try {
        const isFs = execSync(`osascript -e 'tell application "System Events" to get value of attribute "AXFullScreen" of first window of process "VLC"'`, { encoding: "utf8" }).trim();
        windowMode = isFs === "true" ? "fullscreen" : "floating";
      } catch { windowMode = windowMode === "fullscreen" ? "floating" : "fullscreen"; }
      if (windowMode === "fullscreen") {
        try { execSync(`osascript -e 'tell application "VLC" to activate'`, { stdio: "ignore" }); } catch {}
      } else {
        await vlcFloatTopRight();
      }
      res.json({ ok: true });
      return;
    }
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

// ── WebSocket server for phone sync ──
const http = require("http");
const WebSocket = require("ws");
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: "/ws/sync" });

wss.on("connection", (ws) => {
  console.log("  Phone sync: WebSocket connected");
  startWsSync();
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", serverTs: Date.now(), clientTs: data.clientTs }));
      } else if (data.type === "phone-state") {
        _phoneSyncDebug = { ...data, ts: Date.now() };
        if (data.debug) console.log("  Phone DVR:", data.debug);
        if (data.mpvPos !== undefined) console.log(`  Sync: drift=${data.drift} mpv=${data.mpvPos} ph=${data.phonePos} el=${data.elapsed}`);
      } else if (data.type === "vlc-rate" && typeof data.rate === "number") {
        vlcRC(`rate ${data.rate}`).catch(() => {});
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
let _macStatusCache = { locked: false, screenOff: false, frontApp: '', ethernet: false };
let _macStatusInterval = null;
function refreshMacStatus() {
  try { _macStatusCache.locked = execSync(`ioreg -n Root -d1 -w0 | grep -o '"CGSSessionScreenIsLocked"=[a-zA-Z]*'`, { encoding: "utf8", timeout: 2000 }).includes("Yes"); } catch { _macStatusCache.locked = false; }
  try { _macStatusCache.screenOff = execSync(`system_profiler SPDisplaysDataType 2>/dev/null | grep "Display Asleep"`, { encoding: "utf8", timeout: 3000 }).includes("Yes"); } catch { _macStatusCache.screenOff = false; }
  try { _macStatusCache.frontApp = execSync(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`, { encoding: "utf8", timeout: 2000 }).trim(); } catch { _macStatusCache.frontApp = ''; }
  try { _macStatusCache.ethernet = execSync(`ifconfig en3 | grep "status:"`, { encoding: "utf8", timeout: 1000 }).includes("active"); } catch { _macStatusCache.ethernet = false; }
}
refreshMacStatus();
_macStatusInterval = setInterval(refreshMacStatus, 10000);
function startWsSync() {
  if (wsSyncInterval) return;
  wsSyncInterval = setInterval(async () => {
    if (wss.clients.size === 0) return;
    try {
      let state;
      if (activePlayer === "vlc" && vlcProcess && nowPlaying) {
        const s = await vlcStatus();
        if (s.length > 0 && vlcDvrWindow <= 0) vlcDvrWindow = s.length;
        const dvrPos = Math.max(0, vlcDvrWindow - vlcDvrBehind);
        // Absolute time for drift calculation
        let absoluteMs = null;
        const vlcT = vlcTimeNow();
        // Use vlcPdtEpochMs + vlcTime — this reflects what VLC is actually displaying
        // Note: has cumulative precision error but phone calibrates against it
        if (vlcPdtEpochMs && vlcT > 2) {
          absoluteMs = vlcPdtEpochMs + vlcT * 1000;
        } else if (vlcManifestLiveEdgeMs > 0) {
          const liveEdgeNow = vlcManifestLiveEdgeMs + (Date.now() - vlcManifestFetchedAt);
          absoluteMs = liveEdgeNow - vlcDvrBehind * 1000;
        }
        const vlcRealBehind = vlcDvrBehind;
        state = {
          type: "playback",
          playing: true, isLive: true, player: "vlc",
          position: dvrPos, duration: vlcDvrWindow, vlcTime: s.time || undefined,
          vlcBehind: vlcRealBehind,
          paused: vlcPaused, absoluteMs: absoluteMs ? absoluteMs + syncOffsetMs : null,
          url: nowPlaying, serverTs: Date.now(),
          title: historyMap.get(nowPlaying)?.title || "",
          channel: historyMap.get(nowPlaying)?.channel || "",
          monitor: currentMonitor, windowMode: windowMode || "floating", visible: !phoneActive,
          seeking: vlcSeekBusy
        };
      } else if (activePlayer === "mpv" && nowPlaying) {
        try {
          const pos = await mpvCommand(["get_property", "time-pos"]);
          const dur = await mpvCommand(["get_property", "duration"]);
          const pause = await mpvCommand(["get_property", "pause"]);
          state = {
            type: "playback",
            playing: true, isLive: false, player: "mpv",
            position: pos?.data || 0, duration: dur?.data || 0,
            paused: pause?.data || false,
            url: nowPlaying, serverTs: Date.now(),
            title: historyMap.get(nowPlaying)?.title || "",
            channel: historyMap.get(nowPlaying)?.channel || "",
            monitor: currentMonitor, windowMode: windowMode || "floating", visible: !phoneActive
          };
        } catch {
          state = { type: "playback", playing: false };
        }
      } else {
        state = { type: "playback", playing: false };
      }
      state.macStatus = _macStatusCache;
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
      // mpv might have a YouTube URL or a direct stream URL
      if (url) {
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
        console.log("  Reconnected to mpv:", nowPlaying.substring(0, 60), "mode:", windowMode);
        await mpvCommand(["set_property", "vid", "auto"]).catch(() => {}); // restore video if phone mode hid it
        // Start progress tracking for reconnected player
        startProgressTracking(nowPlaying);
        // Monitor mpv liveness — if IPC fails, clean up state
        const mpvMonitor = setInterval(async () => {
          try { await mpvCommand(["get_property", "pid"]); }
          catch { clearInterval(mpvMonitor); progressGen++; if (progressInterval) { clearInterval(progressInterval); progressInterval = null; } mpvProcess = null; nowPlaying = null; activePlayer = null; }
        }, 5000);
      }
    }
  } catch {}

  // Check VLC
  if (!activePlayer) {
    try {
      const time = await vlcRC("get_time");
      if (time && time !== "") {
        activePlayer = "vlc";
        vlcProcess = { kill: () => { try { execSync("pkill -f VLC", { stdio: "ignore" }); } catch {} } };
        // Find URL from recent history (most recent live stream)
        const liveEntry = history.find(h => h.url);
        if (liveEntry) nowPlaying = liveEntry.url;
        console.log("  Reconnected to VLC:", (nowPlaying || "unknown").substring(0, 60));
        startVlcTimeModel();
        // Fetch HLS URL if not cached (needed for DVR scrubbing and phone sync)
        if (!lastVlcHlsUrl && nowPlaying) {
          try {
            const { stdout } = await execFileP("yt-dlp", ["--cookies", COOKIES_FILE, "-f", "301/300/96/95/94/93", "--get-url", nowPlaying], { timeout: 15000 });
            if (stdout.trim()) lastVlcHlsUrl = stdout.trim();
          } catch {}
        }
        vlcDvrBehind = 0; // reset stale DVR offset from previous session
        if (lastVlcHlsUrl) { fetchPdtFromUrl(lastVlcHlsUrl); startDvrRefresh(); }
        // Monitor VLC liveness
        const vlcMonitor = setInterval(async () => {
          try { await vlcRC("get_time"); }
          catch { clearInterval(vlcMonitor); vlcProcess = null; nowPlaying = null; activePlayer = null; }
        }, 5000);
      }
    } catch {}
  }
});
