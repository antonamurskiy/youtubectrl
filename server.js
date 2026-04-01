require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;
const API_KEY = process.env.YOUTUBE_API_KEY;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
const YT_API = "https://www.googleapis.com/youtube/v3";
const TOKENS_FILE = path.join(__dirname, ".tokens.json");
const HISTORY_FILE = path.join(__dirname, ".history.json");

// Persistent history
let history = [];
try {
  if (fs.existsSync(HISTORY_FILE)) {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  }
} catch {}

function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function addToHistory(url, title) {
  // Update existing or add new
  const existing = history.find((h) => h.url === url);
  if (existing) {
    existing.timestamp = Date.now();
    if (title) existing.title = title;
    // Move to top
    history = [existing, ...history.filter((h) => h.url !== url)];
  } else {
    history.unshift({ url, title, timestamp: Date.now(), position: 0, duration: 0 });
  }
  history = history.slice(0, 100);
  saveHistory();
}

function updateHistoryProgress(url, position, duration) {
  const entry = history.find((h) => h.url === url);
  if (entry) {
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
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } else {
    try { fs.unlinkSync(TOKENS_FILE); } catch {}
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
  const res = await fetch(url, { headers });
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
  // YouTube API max 50 IDs per call — batch
  const results = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await ytFetch("videos", {
      part: "snippet,contentDetails,statistics,liveStreamingDetails",
      id: batch.join(","),
    }, accessToken);
    results.push(...data.items.map(mapVideo));
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
app.get("/api/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ videos: [], nextPageToken: null });

  try {
    const YouTube = require("youtube-sr").default;
    const results = await YouTube.search(query, { limit: 20, type: "video" });
    res.json({ videos: results.map((v) => ({
      id: v.id,
      title: v.title,
      thumbnail: v.thumbnail?.url,
      duration: v.durationFormatted,
      channel: v.channel?.name,
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
  const execP = require("util").promisify(require("child_process").execFile);
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
    "--cookies-from-browser", "firefox",
    "--flat-playlist", "--dump-json", "--no-warnings",
    "-I", `1:${count}`,
    `https://www.youtube.com/feed/${feed}`,
  ];
  const opts = { timeout: 25000, maxBuffer: 10 * 1024 * 1024 };

  // Fetch both feeds in parallel
  const [rec, subs] = await Promise.all([
    execP("yt-dlp", ytdlpArgs("recommended", 50), opts).then(r => parseVideos(r.stdout)).catch(() => []),
    execP("yt-dlp", ytdlpArgs("subscriptions", 100), opts).then(r => parseVideos(r.stdout)).catch(() => []),
  ]);

  // Merge: recommended first, then subscriptions (deduped)
  const seen = new Set();
  const videos = [];
  for (const v of [...rec, ...subs]) {
    if (!seen.has(v.id)) { seen.add(v.id); videos.push(v); }
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
    if (page === 0 || !homeFeedCache.length) {
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
          const h = history.find(x => x.url === v.url);
          const merged = e ? { ...v, channel: e.channel || v.channel, views: e.views || v.views, uploadedAt: e.uploadedAt || "", duration: e.duration || v.duration, live: e.live || false, concurrentViewers: e.concurrentViewers } : v;
          if (h?.position > 0 && h?.duration > 0) { merged.savedPosition = h.position; merged.savedDuration = h.duration; }
          return merged;
        }), hasMore });
      } catch {}
    }
    res.json({ videos: slice.map(v => {
      const h = history.find(x => x.url === v.url);
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
  const YouTube = require("youtube-sr").default;

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
    const YouTube = require("youtube-sr").default;
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
const { spawn, execSync } = require("child_process");

let mpvProcess = null;
let nowPlaying = null;
let windowMode = null; // 'fullscreen' | 'maximize' | 'floating' | null
let progressInterval = null;

app.get("/api/now-playing", (_req, res) => {
  res.json({ url: nowPlaying });
});

app.post("/api/play", async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith("https://www.youtube.com/")) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  try {
    const savedEntry = history.find((h) => h.url === url);
    const pos = savedEntry?.position || 0;
    const dur = savedEntry?.duration || 0;
    const resumePos = pos > 0 && dur > 0 && pos < dur * 0.95 && pos < dur - 10 ? pos : 0;

    // If mpv is already running, load new video in existing player
    let reused = false;
    if (mpvProcess) {
      try {
        // Save current video's progress before switching (with timeout)
        try {
          const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej('timeout'), ms))]);
          const [pos, dur] = await timeout(Promise.all([
            mpvCommand(["get_property", "time-pos"]),
            mpvCommand(["get_property", "duration"]),
          ]), 2000);
          if (pos?.data && dur?.data && nowPlaying) updateHistoryProgress(nowPlaying, pos.data, dur.data);
        } catch {}
        await mpvCommand(["loadfile", url, "replace"]);
        nowPlaying = url;
        addToHistory(url, "");
        res.json({ ok: true });

        if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
        (async () => {
          // Wait for video to load, seek to resume, set up progress
          let loaded = false;
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
              const d = await mpvCommand(["get_property", "duration"]);
              if (d?.data > 0) { loaded = true; break; }
            } catch {}
          }
          if (!loaded) {
            // Remove from history if it never loaded
            history = history.filter(h => h.url !== url);
            saveHistory();
            nowPlaying = null;
            return;
          }
          if (resumePos > 0) {
            try { await mpvCommand(["seek", resumePos, "absolute"]); } catch {}
          }
          try {
            const t = await mpvCommand(["get_property", "media-title"]);
            if (t?.data) { history[0].title = t.data; saveHistory(); }
          } catch {}
          progressInterval = setInterval(async () => {
            try {
              const [pos, dur] = await Promise.all([
                mpvCommand(["get_property", "time-pos"]),
                mpvCommand(["get_property", "duration"]),
              ]);
              if (pos?.data && dur?.data) updateHistoryProgress(nowPlaying, pos.data, dur.data);
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
    const mpvArgs = [`--input-ipc-server=/tmp/mpv-socket`, `--ytdl-raw-options=cookies-from-browser=firefox`, `--keep-open`];
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
          execSync(`aerospace fullscreen on --window-id ${wid}`, { stdio: "ignore" });
        } else {
          await floatTopRight(wid);
        }
      } catch {}
    };
    applyWindowMode();
    addToHistory(url, "");

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

    res.json({ ok: true });
  } catch (err) {
    console.error("Play error:", err);
    res.status(500).json({ error: "Failed to play video" });
  }
});

// Stop playback
app.post("/api/stop", async (_req, res) => {
  // Save final position before stopping
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
  res.json({ ok: true });
});

// IPC helper for mpv
const net = require("net");
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
  if (!mpvProcess || !nowPlaying) {
    return res.json({ playing: false });
  }
  try {
    const pos = await mpvCommand(["get_property", "time-pos"]);
    const dur = await mpvCommand(["get_property", "duration"]);
    const title = await mpvCommand(["get_property", "media-title"]);
    const paused = await mpvCommand(["get_property", "pause"]).catch(() => ({ data: false }));
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
      paused: paused?.data || false,
      fullscreen: fs?.data || false,
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
    await mpvCommand(["seek", position, "absolute"]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Seek failed" });
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

  // Fall back to local history
  res.json(history.map((h) => {
    const m = h.url.match(/v=([\w-]+)/);
    return {
      id: m ? m[1] : "",
      title: h.title || h.url,
      thumbnail: m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : "",
      duration: "",
      channel: "",
      views: 0,
      url: h.url,
      savedPosition: h.position || 0,
      savedDuration: h.duration || 0,
    };
  }));
});

// Check live status for a video
app.get("/api/live-status", async (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.json({});
  try {
    const YouTube = require("youtube-sr").default;
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
  const { volume } = req.body;
  try {
    execSync(`osascript -e 'set volume output volume ${Math.round(volume)}'`, { stdio: "ignore" });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Volume failed" });
  }
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
    const pos = await mpvCommand(["get_property", "time-pos"]);
    const seconds = Math.floor(pos?.data || 0);
    const m = nowPlaying.match(/v=([\w-]+)/);
    const videoId = m ? m[1] : "";
    // Get stream URL — MP4 for VOD (precise seeking), HLS for live
    const { stdout } = await require("util").promisify(require("child_process").execFile)(
      "yt-dlp", ["--cookies-from-browser", "firefox", "-f", "18/best[height<=720]", "--get-url", nowPlaying],
      { timeout: 15000 }
    );
    const streamUrl = stdout.trim().split("\n")[0];
    const title = await mpvCommand(["get_property", "media-title"]);
    res.json({ streamUrl, seconds, videoId, title: title?.data || "" });
  } catch (err) {
    console.error("Watch on phone error:", err.message);
    // Fallback to YouTube URL
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

// Comments — uses yt-dlp (no quota)
app.get("/api/comments", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.json([]);

  try {
    const { stdout } = await require("util").promisify(require("child_process").execFile)(
      "yt-dlp", [
        "--cookies-from-browser", "firefox",
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
  try {
    await mpvCommand(["cycle", "pause"]);
    const state = await mpvCommand(["get_property", "pause"]);
    const paused = !!state?.data;
    // Hide window when paused in floating/maximize mode, show when playing
    if (windowMode === "floating" || windowMode === "maximize") {
      try {
        await mpvCommand(["set_property", "vid", paused ? "no" : "auto"]);
        // Re-apply window mode after restoring video
        if (!paused) {
          await new Promise(r => setTimeout(r, 300));
          try {
            const wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
            if (wid) {
              if (windowMode === "maximize") {
                execSync(`aerospace focus --window-id ${wid}`, { stdio: "ignore" });
                execSync(`aerospace fullscreen on --window-id ${wid}`, { stdio: "ignore" });
              } else {
                await floatTopRight(wid);
              }
            }
          } catch {}
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
function getScreenInfo() {
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
  return JSON.parse(out.trim());
}

// Move mpv between monitors — uses aerospace to move, then re-applies current window mode
app.post("/api/move-monitor", async (req, res) => {
  if (windowLock) return res.json({ ok: true, skipped: true });
  windowLock = true;
  const { target } = req.body;
  try {
    const wid = execSync("aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}' | tr -d ' ' | head -1", { encoding: "utf8" }).trim();
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
        execSync(`aerospace fullscreen on --window-id ${wid}`, { stdio: "ignore" });
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
function getScreenOrigins() {
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
      execSync(`aerospace fullscreen on --window-id ${wid}`, { stdio: "ignore" });
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
    const fs = await mpvCommand(["get_property", "fullscreen"]);
    if (fs?.data === true) {
      // Exiting fullscreen — float in top-right corner
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`YouTubeCtrl running at http://localhost:${PORT}`);
  if (!API_KEY) console.warn("  WARNING: YOUTUBE_API_KEY not set in .env");
  if (!CLIENT_ID) console.warn("  WARNING: GOOGLE_CLIENT_ID not set in .env");
  const nets = require("os").networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) {
      if (cfg.family === "IPv4" && !cfg.internal) {
        console.log(`  Phone: http://${cfg.address}:${PORT}`);
      }
    }
  }
});
