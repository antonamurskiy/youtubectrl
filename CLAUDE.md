# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

YouTubeCtrl — a local web app to browse/search YouTube on your phone and play videos on your computer via mpv (VODs) or VLC (live streams with DVR). Single-user, runs on the local network.

## Commands

```bash
npm start          # Start server on port 3000
npm install        # Install dependencies
pkill -x mpv       # Kill all mpv instances
```

## Architecture

**Single server (`server.js`) + single-page frontend (`public/index.html`), no build step.**

### Content Sources (three-tier fallback to minimize API quota)

| Endpoint | Primary (free) | Fallback (costs quota) |
|---|---|---|
| `/api/search` | youtube-sr scraper | YouTube Data API search (100 units!) |
| `/api/trending` | youtube-sr search | YouTube Data API mostPopular (1 unit) |
| `/api/home` | yt-dlp recommended + subscriptions (Firefox cookies) | YouTube Data API enrichment (1 unit/50 videos) |
| `/api/live` | yt-dlp home feed (live items) + youtube-sr | YouTube Data API enrichment |
| `/api/history` | YouTube browse API (cookies) + local `.history.json` | — |

YouTube Data API quota is 10,000 units/day. Search costs 100 units per call. Always prefer youtube-sr for search.

### Auth & YouTube History

- YouTube browse API for history uses Firefox cookies (SAPISID + SAPISIDHASH auth) — no OAuth needed
- `parseCookieFile()` reads `cookies.txt` (Netscape format), `sapisidHash()` computes the auth header
- YouTube history now uses `lockupViewModel` renderer (not `videoRenderer`) — extract `contentId`, `title`, `channel` from nested metadata, `startPercent` from `thumbnailOverlayProgressBarViewModel`
- OAuth (optional): scope `youtube.force-ssl`, tokens in `.tokens.json`, auto-refreshed
- OAuth client shared with the `/dev/hk` project (Nest integration)
- Redirect URI: `http://localhost:3000/oauth/callback`

### mpv Playback

- Spawned with `--input-ipc-server=/tmp/mpv-socket` + `--keep-open` + `--ytdl-raw-options=cookies=cookies.txt`
- Unix domain socket sends JSON commands: `{"command": ["get_property", "time-pos"]}`
- mpv keeps the socket open — read first complete JSON line with `request_id`, then close
- New videos loaded via `loadfile` IPC command (reuses existing window/position) — only spawns new mpv if no existing player
- Playback position saved every 10s to `.history.json`, also saved on stop and before switching videos
- Progress saved to `nowPlaying` (not captured URL) to prevent cross-video corruption
- Videos only added to history after confirming they loaded (duration > 0); removed if mpv crashes within 5s
- `progressInterval` uses a generation counter (`progressGen`) to prevent overlapping intervals from rapid play requests
- `startProgressTracking(url)` captures the URL at setup time to prevent saving progress to the wrong video
- Cross-device resume: `watchPct` from YouTube history API → mpv `--start=N%` (percentage-based seek)

### VLC Playback (Live Streams)

- **Why VLC**: mpv/ffmpeg's HLS demuxer cannot seek outside its local cache in live streams. VLC has its own HLS demuxer that properly re-requests segments from YouTube's CDN, enabling full DVR seeking.
- VLC 4.0 nightly (`brew install --cask vlc@nightly`) — must clear quarantine: `xattr -cr /Applications/VLC.app`
- Controlled via CLI RC interface over TCP (`--extraintf cli --rc-host 127.0.0.1:9091`)
- RC commands: `get_time`, `get_length`, `is_playing`, `seek N`, `pause`, `fullscreen`, `clear`, `add`
- RC responses are plain text (just the value + newline), no JSON, no prompt
- **CRITICAL: VLC RC calls must be sequential** — `vlcStatus()` queries `get_time`, `get_length`, `is_playing` one at a time. Parallel TCP connections cause VLC to hang or crash, especially during seeks.
- `get_time` returns integer seconds only — use `vlcTimeModel` for sub-second interpolation (detects integer transitions at 1s polling)
- `vlcPaused` is toggled manually in playpause handler — do NOT sync from `is_playing` in the playback poll (causes race condition that prevents window hide on pause)
- **Stream switching without restart**: write HLS URL to `/tmp/vlc-next.m3u`, then `clear` + `add /tmp/vlc-next.m3u` via RC (direct URLs are too long for RC's line buffer)
- VLC 4 removed the HTTP Lua interface from VLC 3 — must use CLI RC instead
- VLC 4 has a sidebar/media library that cannot be disabled via config or CLI flags
- VLC enforces minimum window size based on video aspect ratio — cannot resize smaller via AppleScript
- Hide on pause / show on resume: `osascript` to set `visible of process "VLC"` (same as mpv)
- VLC 4 DVR HLS seeking is fragile — can hang on large seeks. Not a code issue, VLC bug.

### AeroSpace Integration

- mpv rule: `layout floating` with `check-further-callbacks = false` — aerospace can't switch mpv to tiling
- VLC has no aerospace rule — it's a normal managed window
- Monitor 1 (Built-in/laptop) = workspace 8, Monitor 2 (LG UltraFine) = workspace 1
- Three window modes tracked server-side (`windowMode`): `floating`, `maximize` (aerospace fullscreen with dock), `fullscreen` (native)
- Floating: top-right corner, always-on-top (mpv only), auto-hides on pause
- Moving between monitors: mpv uses fullscreen bounce; VLC uses `aerospace move-node-to-workspace`
- **mpv maximize**: `aerospace fullscreen --no-outer-gaps on/off` works directly on floating windows
- **VLC maximize**: must `layout tiling` first, then `fullscreen --no-outer-gaps on`; exit with `fullscreen off` then `layout floating`
- `vlcAerospace()` helper wraps try/catch since commands like `layout tiling` fail if already tiled
- Find window IDs: `aerospace list-windows --all | grep mpv` or `grep VLC`

### HiDPI and Resolution Switching

- LG UltraFine: 5120x2880 native, "looks like" 2560x1440 (HiDPI scaled)
- MacBook: 2560x1664 native, "looks like" 1470x956 (HiDPI scaled)
- Toggle resolution script (`~/.config/aerospace/scripts/toggle-resolution.sh`): switches LG between 1280x720 and 2560x1440
- **mpv geometry must use percentage-based sizes** (e.g., `38%-12+38`) — pixel values get halved by HiDPI scaling
- `displayplacer list` gives actual logical resolution and screen origins (e.g., laptop at `(-1470, 124)`)
- `getScreenInfo()` uses `system_profiler` for resolution; `getScreenOrigins()` uses `displayplacer` for position
- AppleScript `System Events` coordinates match logical (scaled) resolution
- AppleScript cannot move floating windows across monitors (aerospace pins them) — use mpv's fullscreen bounce instead

### Phone Mode (Watch on Phone)

- Phone plays the same video as the desktop player, synced via polling
- **VOD (mpv)**: phone gets direct YouTube MP4 URL, sync loop polls `/api/playback` every 1s, hard-seeks if drift > 2s. Follows desktop scrubs and pause/resume.
- **Live (VLC)**: phone gets the same HLS URL as VLC (same format `301/300/96/95/94/93`), plays natively on iOS Safari. Calibrated offset syncs time bases. VLC's 10s cache delay (`--network-caching 5000 --live-caching 5000`) means phone shows content ~10s ahead — subtracted from target in sync loop.
- **iOS Safari limitations**: no MSE (can't use hls.js), ignores `playbackRate` on live HLS, seeks snap to 2s keyframe boundaries. Fragmented MP4 via pipe doesn't play (needs Content-Length). These prevent <0.1s live sync on iOS.
- Phone player is `position:fixed` on `document.body` — secret menu hides it when open (z-index stacking doesn't work reliably across Safari's position:fixed contexts)
- Video swap: when switching videos with phone active, re-hides mpv video and updates phone `src` in-place
- `closePhonePlayer()` restores mpv video track (`vid=auto`), clears sync interval, kills ffmpeg relay
- fMP4 relay (`/api/phone-live-stream`): ffmpeg remuxes HLS→fragmented MP4 with `-bsf:a aac_adtstoasc`. Works in Chrome (achieved 0.001s drift with rate sync) but not Safari (no MSE for streaming fMP4).
- iOS lock screen media controls via Media Session API — silent audio (`public/silent.m4a`, truly silent, volume=1) keeps the Now Playing widget alive. Pausing from app or lock screen pauses the silent audio to stop the timer.

### Frontend

- Vanilla JS, no framework. All in `public/index.html`
- Responsive: mobile list layout (<768px) + desktop grid layout (768px+) with hover preview
- Brutalist DOS aesthetic: JetBrains Mono, black bg, gray text
- Now-playing bar: fixed bottom, polls `/api/playback` via `setTimeout` chaining (not `setInterval` — prevents overlapping polls). `AbortController` with 5s timeout on poll fetch.
- `isSeeking` flag prevents poll from overwriting user's drag position. Held until poll confirms position within 3s of seek target (not a fixed timeout).
- Load generation counter (`loadGen`) discards stale responses from interleaved tab/search loads
- `touch-action: manipulation` on `*` to prevent double-tap zoom
- YouTube URL pasted in search box auto-plays immediately
- Tabs: Home, Live, History
- Secret menu (tap "ytctrl" logo): volume slider (system volume), toggle resolution
- FABs: top-right (hamburger → secret menu), bottom-right (refresh, long-press → tab switcher)
- Long-press context menu on video cards: "More from [channel]" (yt-dlp channel scrape), "Copy link"
- Seek preview: storyboard thumbnails from YouTube sprite sheets + time bubble above thumb while dragging
- Current position marker (white line) shown during scrub, fades out after release
- Home feed paginated: 24 videos per page, infinite scroll loads more
- Event delegation for video card clicks (one handler on grid, not per-card)
- All polling pauses when tab is hidden (visibility API), phone sync interval persists (no-ops when vid paused in background), immediate re-sync on tab return
- Cookies exported from Firefox to `cookies.txt` on server startup (requires Mac to be unlocked)
- `POST /api/refresh-cookies` to re-export if cookies expire
- Firefox must be installed and logged into YouTube

## Key Files

- `.env` — `YOUTUBE_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `.tokens.json` — OAuth tokens (runtime, gitignored)
- `.history.json` — Watch history with position/duration (runtime, gitignored)
- `cookies.txt` — Firefox YouTube cookies, exported on startup (runtime, gitignored)
- `/tmp/mpv-socket` — mpv IPC socket (runtime)
- `/tmp/vlc-next.m3u` — temp file for VLC stream switching (runtime)
- `activePlayer` — server-side variable: `'mpv'` | `'vlc'` | `null`
- `lastVlcHlsUrl` — stored HLS URL for fMP4 relay and stream reload
- `public/silent.m4a` — truly silent 5-minute m4a for iOS Media Session (must be actual silence, not low volume — iOS drops session at volume=0)
