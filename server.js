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
    execFileP("yt-dlp", ytdlpArgs("recommended", 50), opts).then(r => parseVideos(r.stdout)).catch(() => []),
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

// Cache raw home feed so pagination doesn't re-fetch
let homeFeedCache = [];

app.get("/api/home", async (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const pageSize = 24;
  try {
    // Fetch fresh feed on page 0, use cache for subsequent pages
    if (page === 0) {
      homeFeedCache = await getHomeFeed();
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
        }), hasMore });
      } catch {}
    }
    res.json({ videos: slice.map(v => {
      const h = historyMap.get(v.url);
      if (h?.position > 0 && h?.duration > 0) { v.savedPosition = h.position; v.savedDuration = h.duration; }
      return v;
    }), hasMore });
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
let progressInterval = null;
let activePlayer = null; // 'mpv' | 'vlc' | null
let vlcPaused = false;

const VLC_RC_PORT = 9091;
function vlcRC(cmd) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(VLC_RC_PORT, "127.0.0.1", () => {
      client.write(cmd + "\n");
    });
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk;
      if (buf.includes("\n")) {
        client.destroy();
        resolve(buf.trim());
      }
    });
    client.on("error", reject);
    setTimeout(() => { client.destroy(); resolve(buf.trim()); }, 1000);
  });
}
async function vlcStatus() {
  const [time, length, playing] = await Promise.all([
    vlcRC("get_time").then(s => parseInt(s) || 0),
    vlcRC("get_length").then(s => parseInt(s) || 0),
    vlcRC("is_playing").then(s => s.trim() === "1"),
  ]);
  return { time, length, state: playing ? "playing" : "paused", fullscreen: false };
}
async function vlcSeek(val) { return vlcRC(`seek ${val}`); }
async function vlcPause() { return vlcRC("pause"); }
async function vlcCommand(cmd) { return vlcRC(cmd); }

function killVlc() {
  if (vlcProcess) { try { vlcProcess.kill("SIGKILL"); } catch {} vlcProcess = null; }
  try { execSync("pkill -f VLC", { stdio: "ignore" }); } catch {}
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
  killVlc();
  vlcProcess = spawn("/Applications/VLC.app/Contents/MacOS/VLC", [
    "--extraintf", "cli",
    "--rc-host", `127.0.0.1:${VLC_RC_PORT}`,
    "--no-video-title-show", "--no-fullscreen",
    "--network-caching", "5000",
    "--live-caching", "5000",
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
  const initVlc = (attempts = 0) => {
    if (attempts > 15) return;
    try {
      execSync(`osascript -e 'tell application "System Events" to get size of first window of process "VLC"'`, { encoding: "utf8" });
      // Force exit fullscreen if VLC restored to it
      try {
        const isFs = execSync(`osascript -e 'tell application "System Events" to get value of attribute "AXFullScreen" of first window of process "VLC"'`, { encoding: "utf8" }).trim();
        if (isFs === "true") {
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
}

app.get("/api/now-playing", (_req, res) => {
  res.json({ url: nowPlaying });
});

let playLock = false;
app.post("/api/play", async (req, res) => {
  if (playLock) return res.json({ ok: true, queued: true });
  playLock = true;
  const { url, isLive, title: reqTitle, channel: reqChannel } = req.body;
  if (!url || !url.startsWith("https://www.youtube.com/")) {
    playLock = false;
    return res.status(400).json({ error: "Invalid URL" });
  }

  try {
    // If live, use VLC for DVR support
    if (isLive) {
      // Kill mpv if switching from VOD to live
      if (mpvProcess) { try { mpvProcess.kill("SIGKILL"); } catch {} mpvProcess = null; }
      if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
      // Get HLS URL via yt-dlp
      const { stdout } = await execFileP(
        "yt-dlp", ["--cookies", COOKIES_FILE, "-f", "301/300/96/95/94/93", "--get-url", url],
        { timeout: 15000 }
      );
      const hlsUrl = stdout.trim();
      if (activePlayer === "vlc" && vlcProcess) {
        // Switch stream without restarting VLC — write URL to temp file and load it
        fs.writeFileSync("/tmp/vlc-next.m3u", hlsUrl);
        await vlcRC("clear");
        await vlcRC("add /tmp/vlc-next.m3u");
      } else {
        killVlc();
        spawnVlc(hlsUrl);
      }
      nowPlaying = url;
      addToHistory(url, reqTitle || "", reqChannel || "");
      markWatchedOnYouTube(url);
      playLock = false;
      return res.json({ ok: true, player: "vlc" });
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
        // Unhide if it was hidden from pause
        try { execSync(`osascript -e 'tell application "System Events" to set visible of process "mpv" to true'`, { stdio: "ignore" }); } catch {}
        nowPlaying = url;
        addToHistory(url, reqTitle || "", reqChannel || "");
        // Reset position for this video to prevent stale data from corrupting resume
        const entry = historyMap.get(url);
        if (entry && resumePos <= 0) { entry.position = 0; entry.duration = 0; }
        playLock = false;
        res.json({ ok: true });
        const expectedUrl = url;
        const oldDuration = await mpvCommand(["get_property", "duration"]).then(r => r?.data || 0).catch(() => 0);
        (async () => {
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
          // Always seek — to resume position or to start (mpv carries over old position)
          try {
            if (resumePos > 0) {
              const actualDur = await mpvCommand(["get_property", "duration"]);
              if (actualDur?.data && resumePos < actualDur.data * 0.95) {
                await mpvCommand(["seek", resumePos, "absolute"]);
              } else {
                await mpvCommand(["seek", 0, "absolute"]);
              }
            } else {
              await mpvCommand(["seek", 0, "absolute"]);
            }
          } catch {}
          // Re-apply window mode in case loadfile disrupted it
          if (windowMode === "maximize") {
            try {
              const wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
              if (wid) {
                execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" });
                execSync(`aerospace fullscreen --no-outer-gaps on --window-id ${wid}`, { stdio: "ignore" });
              }
            } catch {}
          }
          try {
            const t = await mpvCommand(["get_property", "media-title"]);
            if (t?.data) { history[0].title = t.data; saveHistory(); }
          } catch {}
          markWatchedOnYouTube(url);
          if (progressInterval) clearInterval(progressInterval);
          progressInterval = setInterval(async () => {
            try {
              const [pos, dur] = await Promise.all([
                mpvCommand(["get_property", "time-pos"]),
                mpvCommand(["get_property", "duration"]),
              ]);
              if (pos?.data && dur?.data && nowPlaying && pos.data < dur.data * 1.05) updateHistoryProgress(nowPlaying, pos.data, dur.data);
            } catch {}
          }, 10000);
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
    const mpvArgs = [`--input-ipc-server=/tmp/mpv-socket`, `--ytdl-raw-options=cookies=${COOKIES_FILE}`, `--hwdec=auto-safe`, `--keep-open`, `--demuxer-max-back-bytes=2G`, `--cache=yes`];
    if (geometry) mpvArgs.push(`--geometry=${geometry}`, `--ontop`);
    if (windowMode === "fullscreen") mpvArgs.push(`--fs`);
    mpvArgs.push(url);
    if (resumePos > 0) mpvArgs.push(`--start=${Math.floor(resumePos)}`);

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
      if (progressInterval) clearInterval(progressInterval);
      progressInterval = setInterval(async () => {
        try {
          const [pos, dur] = await Promise.all([
            mpvCommand(["get_property", "time-pos"]),
            mpvCommand(["get_property", "duration"]),
          ]);
          if (pos?.data && dur?.data) updateHistoryProgress(nowPlaying, pos.data, dur.data);
        } catch {}
      }, 10000);
    }, 5000);

    child.on("exit", async (code) => {
      if (progressInterval) clearInterval(progressInterval);
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
    const client = net.createConnection("/tmp/mpv-socket", () => {
      client.write(JSON.stringify({ command: cmd }) + "\n");
    });
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk;
      // mpv sends newline-delimited JSON; grab first complete line
      const lines = buf.split("\n");
      for (const line of lines) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if ("request_id" in parsed) {
            client.destroy();
            resolve(parsed);
            return;
          }
        } catch {}
      }
    });
    client.on("error", (err) => { client.destroy(); reject(err); });
    setTimeout(() => { client.destroy(); resolve(null); }, 2000);
  });
}

// Get playback position
app.get("/api/playback", async (_req, res) => {
  // VLC playback
  if (activePlayer === "vlc" && vlcProcess && nowPlaying) {
    try {
      const s = await vlcStatus();
      let monitor = "lg";
      try {
        const posStr = execSync(`osascript -e 'tell application "System Events" to get position of first window of process "VLC"'`, { encoding: "utf8" }).trim();
        const x = parseInt(posStr.split(",")[0]);
        monitor = x < 0 ? "laptop" : "lg";
      } catch {}
      return res.json({
        playing: true,
        url: nowPlaying,
        position: s.time || 0,
        duration: Math.max(s.time || 0, s.length || 0),
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
    const pos = await mpvCommand(["get_property", "time-pos"]);
    const dur = await mpvCommand(["get_property", "duration"]);
    const title = await mpvCommand(["get_property", "media-title"]);
    const paused = await mpvCommand(["get_property", "pause"]).catch(() => ({ data: false }));
    const fileFormat = await mpvCommand(["get_property", "file-format"]).catch(() => ({ data: "" }));
    const isLive = (fileFormat?.data || "").includes("hls");
    const fs = await mpvCommand(["get_property", "fullscreen"]).catch(() => ({ data: false }));
    let monitor = "lg";
    if (fs?.data) {
      const fsScreen = await mpvCommand(["get_property", "fs-screen"]).catch(() => ({ data: 0 }));
      const screens = getScreenInfo();
      const mainIdx = screens.findIndex(s => s.main);
      monitor = fsScreen?.data === mainIdx ? "lg" : "laptop";
    } else {
      // Floating — check window position
      try {
        const posStr = execSync(`osascript -e 'tell application "System Events" to get position of first window of process "mpv"'`, { encoding: "utf8" }).trim();
        const x = parseInt(posStr.split(",")[0]);
        monitor = x < 0 ? "laptop" : "lg";
      } catch {}
    }
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
      monitor,
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
    if (activePlayer === "vlc") {
      await vlcSeek(Math.floor(position));
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
      const s = await vlcStatus();
      await vlcSeek(Math.max(0, (s.time || 0) + offset));
      return res.json({ ok: true });
    }
    await mpvCommand(["seek", offset, "relative"]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Seek failed" });
  }
});

// History — YouTube internal API, falls back to local
async function getYouTubeHistory(token) {
  const res = await fetch("https://www.youtube.com/youtubei/v1/browse", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      browseId: "FEhistory",
      context: {
        client: { clientName: "WEB", clientVersion: "2.20240101.00.00" },
      },
    }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json();

  // Extract videos from the nested response
  const videos = [];
  function extract(obj, depth) {
    if (depth > 20 || videos.length >= 30) return;
    if (typeof obj !== "object" || !obj) return;
    if (Array.isArray(obj)) { obj.forEach((i) => extract(i, depth + 1)); return; }
    if (obj.videoRenderer) {
      const vr = obj.videoRenderer;
      const title = vr.title?.runs?.[0]?.text || "";
      const channel = vr.shortBylineText?.runs?.[0]?.text || "";
      const dur = vr.lengthText?.simpleText || "";
      const views = vr.viewCountText?.simpleText || "";
      videos.push({
        id: vr.videoId,
        title,
        thumbnail: `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`,
        duration: dur,
        channel,
        views: parseInt((views.match(/[\d,]+/) || ["0"])[0].replace(/,/g, "")) || 0,
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
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

  // Try YouTube internal API first
  if (token) {
    try {
      const videos = await getYouTubeHistory(token);
      if (videos.length) return res.json(videos);
    } catch (err) {
      console.error("YouTube history API failed:", err.message);
    }
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

// Watch on phone — get direct stream URL
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
    }
    const m = nowPlaying.match(/v=([\w-]+)/);
    const videoId = m ? m[1] : "";
    const { stdout } = await execFileP(
      "yt-dlp", ["--cookies", COOKIES_FILE, "-f", "18/best[height<=720]", "--get-url", nowPlaying],
      { timeout: 15000 }
    );
    const streamUrl = stdout.trim().split("\n")[0];
    res.json({ streamUrl, seconds, videoId, title: "" });
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
let _storyboardCache = {}; // videoId -> { url, cols, rows, interval }
app.get("/api/storyboard", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.json({});
  if (_storyboardCache[videoId]) return res.json(_storyboardCache[videoId]);
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
      // Fragment duration is per PAGE (cols*rows frames), divide to get per-frame interval
      const pageDur = sbFormat.fragments?.[0]?.duration || 2;
      result.interval = pageDur / (sbFormat.columns * sbFormat.rows);
    }
    _storyboardCache[videoId] = result;
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
        } else {
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
function getScreenInfo() {
  if (_screenInfoCache && Date.now() - _screenInfoAt < 3000) return _screenInfoCache;
  const out = execSync(`python3 -c "
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
"`, { encoding: "utf8" });
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
      execSync(`aerospace fullscreen off --window-id ${wid}`, { stdio: "ignore" });
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

app.listen(PORT, "0.0.0.0", async () => {
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
        windowMode = fs?.data ? "fullscreen" : "floating";
        console.log("  Reconnected to mpv:", nowPlaying.substring(0, 60), "mode:", windowMode);
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
      }
    } catch {}
  }
});
