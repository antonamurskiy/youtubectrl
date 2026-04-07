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

**Server (`server.js`) + React frontend (`client/`) with Vite build step.**

### Frontend Stack
- React + Zustand (state management) + Vite (build)
- Source: `client/src/` — components, hooks, stores
- Build: `cd client && npm run build` → outputs to `client/dist/`
- Server serves `client/dist/` (built React app) + `public/` (static assets like `silent.m4a`)
- Key components: `VideoCard`, `VideoGrid`, `NowPlayingBar`, `PhonePlayer`, `SecretMenu`, `SearchBar`
- Key hooks: `useSync` (WebSocket playback state), `useMediaSession` (iOS lock screen controls), `useDriftSync` (phone sync)
- Key stores: `playback.js` (Zustand — playing/position/duration/title etc), `ui.js`, `sync.js`
- Duration strings from server are pre-formatted ("16:27", "1:02:30") — frontend passes through, only formats raw seconds

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
- **VLC `seek` command is broken for live HLS DVR** — hangs/buffers indefinitely. Do NOT use `vlcSeek()` for live streams.
- **DVR scrubbing uses reload-based seeking**: instead of VLC's `seek`, reload the stream via an HLS proxy (`/api/vlc-hls-offset`) that serves the YouTube manifest with segments trimmed from the end. `clear` + `add /tmp/vlc-next.m3u` reloads VLC at the desired offset.
- **DVR position tracked server-side** (`vlcDvrBehind`): VLC's `get_time` PTS is unreliable for live HLS — resets to a different base after every reload. Do NOT use `get_time` for position tracking in live streams. **`vlcDvrBehind` itself is also unreliable for phone sync** — it's manually tracked and drifts. Phone sync should use PDT-based absolute time (`pb.absoluteMs`) instead.
- **VLC `get_length` reports local buffer, not real DVR window**: after a trimmed reload, `get_length` shrinks. Use `vlcDvrWindow` which is refreshed from the real YouTube manifest every 5s (`startDvrRefresh()`).
- **YouTube HLS `playlist_duration` is signed** — cannot modify the URL to request a larger DVR window. The manifest contains whatever YouTube provides (often 30s for some streams, 2+ hours for others).
- **YouTube HLS manifests can have discontinuities** — multiple `#EXT-X-PROGRAM-DATE-TIME` tags with time gaps. When computing live edge PDT, use the LAST PDT tag + durations after it (not first PDT + total duration).
- `vlcDvrBehind` = 0 at live edge, increases when user scrubs back. "Go live" (seek to duration) sets it to 0 and reloads the original HLS URL directly.
- `vlcSeekBusy` flag blocks seeks for 3s after each reload to let VLC rebuffer.
- `--video-on-top` flag for always-on-top in floating mode
- `/api/vlc-rate` endpoint to set VLC playback rate (used for phone sync experiments, kept for future use)
- `/api/vlc-absolute-time` endpoint: at live edge uses `vlcPdtEpochMs + vlcTimeNow()` (accurate, accounts for VLC buffering); after DVR seeks uses manifest-based calculation (`vlcManifestLiveEdgeMs - vlcDvrBehind`). Returns empty during active seeks (`vlcSeekBusy`) to prevent drift sync from computing bad values.
- `/api/vlc-hls-offset` endpoint: HLS proxy that fetches the real YouTube manifest and trims segments from the end based on `vlcDvrBehind`. VLC refreshes from this URL periodically, maintaining the time offset.
- `/api/mpv-speed` endpoint: sets mpv `speed` property
- `/api/switch-to-vlc` endpoint: switches live stream from mpv to VLC for DVR scrubbing

### AeroSpace Integration

- mpv `floatTopRight()` now sets `aerospace layout floating` + `ontop` (was missing `layout floating`)

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
- **Live (VLC) sync — display-only drift, manual offset buttons**:
  - Phone gets HLS via proxy (`/api/phone-hls`) on Chrome (hls.js, CORS workaround) or YouTube URL directly on Safari (native HLS)
  - **YouTube HLS segments can be 1s** (not always 2s) — `EXT-X-TARGETDURATION` varies per stream. hls.js `liveSyncDurationCount` is multiplied by target duration, so the actual seconds-behind-live depends on the stream. Always check the manifest.
  - **VLC sits ~19-20s behind live edge** even with `--network-caching 1000 --clock-jitter 0 --low-delay`. This is much more than the theoretical ~8s (3 segments + caching). The HLS demuxer, decode pipeline, and display chain add significant hidden delay.
  - **`vlcDvrBehind` is unreliable for sync** — it's manually tracked server-side and drifts. Phone sync currently uses behind-live comparison (`vlcBehind - phoneBehind`) for display only, with manual offset buttons for calibration.
  - **No auto-correction for live** — rate control and seeking both cause more problems than they solve on live HLS. User adjusts offset buttons visually.
  - **VLC `--live-caching` has no effect on HLS** — it only applies to local capture devices. Only `--network-caching` matters for network streams.
  - VLC `get_time` returns integers; `vlcTimeNow()` interpolates sub-second precision
  - Drift naturally grows ~0.02s/s due to clock differences between VLC and hls.js players
  - `fetchPdtFromUrl()` called once at VLC spawn and on reconnect. On reconnect, if `lastVlcHlsUrl` is null, fetches it via yt-dlp.
  - **Two absolute time modes**: at live edge, uses original `vlcPdtEpochMs + vlcTimeNow()`. After DVR seeks (where VLC PTS resets), uses manifest-based: `vlcManifestLiveEdgeMs + elapsed - vlcDvrBehind * 1000`.
- **iOS Safari limitations**: no MSE (can't use hls.js), ignores `playbackRate` on live HLS, seeks snap to 2s keyframe boundaries. Fragmented MP4 via pipe doesn't play (needs Content-Length).
- **Live stream server-side detection**: if frontend doesn't send `isLive` flag (e.g., playing from History tab), server checks via `yt-dlp --print is_live`
- Phone player is `position:fixed` on `document.body` — secret menu hides it when open (z-index stacking doesn't work reliably across Safari's position:fixed contexts)
- Video swap: when switching videos with phone active, re-hides mpv video and updates phone `src` in-place
- `closePhonePlayer()` restores mpv video track (`vid=auto`), clears sync interval, kills ffmpeg relay
- fMP4 relay (`/api/phone-live-stream`): ffmpeg remuxes HLS→fragmented MP4 with `-bsf:a aac_adtstoasc`. Works in Chrome (achieved 0.001s drift with rate sync) but not Safari (no MSE for streaming fMP4).
- iOS lock screen media controls via Media Session API — silent audio (`public/silent.m4a`, truly silent, volume=1) keeps the Now Playing widget alive. Pausing from app or lock screen pauses the silent audio to stop the timer.

### Frontend (React)

- React + Zustand + Vite. Source in `client/src/`, build output in `client/dist/`
- Responsive: mobile list layout (<768px) + desktop grid layout (768px+) with hover preview
- Brutalist DOS aesthetic: JetBrains Mono, black bg, gray text
- Now-playing bar (`NowPlayingBar.jsx`): fixed bottom, state from WebSocket (`useSync` hook) via Zustand playback store
- WebSocket (`/ws/sync`): server pushes playback state every 1s (position, duration, title, channel, monitor, windowMode, paused, isLive, player)
- `touch-action: manipulation` on `*` to prevent double-tap zoom
- YouTube URL pasted in search box auto-plays immediately
- Tabs: Home, Live, History
- Secret menu (tap "ytctrl" logo): volume slider (system volume), toggle resolution, refresh cookies
- Long-press context menu on video cards: "More from [channel]", "Copy link" — position clamped to viewport
- Seek preview: storyboard thumbnails from YouTube sprite sheets + time bubble above thumb while dragging. Live streams show time-behind-live (e.g., `-0:15`) instead of absolute time.
- Current position marker (white line) shown during scrub, fades out after release
- Home feed paginated: 24 videos per page, infinite scroll loads more
- iOS Media Session API (`useMediaSession` hook): silent audio loop (`public/silent.m4a`) for lock screen Now Playing widget with play/pause/seek controls and artwork
- Video badges: `duration` field can be pre-formatted string ("16:27"), "LIVE", or "SOON" — VideoCard handles all three
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
