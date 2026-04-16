# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

YouTubeCtrl — a local web app to browse/search YouTube on your phone and play videos on your computer via mpv. VLC is available for DVR scrubbing on live streams. Single-user, runs on the local network at `yuzu.local:3000`.

## Commands

```bash
npm start          # Start server on port 3000
npm install        # Install dependencies
pkill -x mpv       # Kill all mpv instances
```

**Server lifecycle & macOS permissions**: the server uses `blueutil` and
`osascript` which require the parent process to have Bluetooth +
Accessibility + Automation permissions granted in System Settings. When
the user runs `npm start` from their terminal (iTerm / Warp / Terminal),
those grants apply. If Claude restarts the server from a non-granted
shell (background `node server.js &`, `nohup`, launchd, etc.) the
server will lose access to Bluetooth and possibly mpv window control.
**Prefer asking the user to restart the server themselves** rather than
restarting it via Bash tool when Bluetooth/AppleScript features are in
scope.

## iOS app deployment

The iOS Capacitor shell is at `ios-app/`. Never tell the user to use Xcode —
always build + install + launch from the command line yourself. The iPhone is
connected via USB and paired.

```bash
# Device identifier (iPhone 17 Pro, paired for development)
DEVICE=00008150-001241D11EF2401C
BUNDLE=com.antonamurskiy.ytctl1289
APP_PATH=/Users/antonamurskiy/Library/Developer/Xcode/DerivedData/App-fmgudysqpugrzfaedgrsaukwjilr/Build/Products/Debug-iphoneos/App.app

# 1. Build frontend, sync to Capacitor
cd client && npm run build
cd ../ios-app && npx cap sync ios

# 2. Clean + build iOS for device (-allowProvisioningUpdates refreshes free cert)
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug clean
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -destination "id=$DEVICE" -allowProvisioningUpdates build

# 3. Install + launch on device
xcrun devicectl device install app --device "$DEVICE" "$APP_PATH"
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE"
```

Notes:
- `xcrun devicectl list devices` — confirm device is connected
- DerivedData path is stable per project; if it changes, find it with:
  `find ~/Library/Developer/Xcode/DerivedData -name "App.app" -path "*iphoneos*" | head -1`
- Changes to `server.js` or `client/` alone don't need an iOS rebuild — the
  Capacitor config points the WebView at `yuzu.local:3000` (see
  `ios-app/capacitor.config.json`). Only rebuild iOS for native code
  (`NativePlayerPlugin.swift`, `AppDelegate.swift`, Info.plist) or new
  Capacitor plugins.
- Never ask the user to open Xcode, trust certs, or push buttons. Do it
  yourself via CLI.

### Adding native Swift to the iOS app

When adding a new Swift file to the App target:
1. Create the .swift file under `ios-app/ios/App/App/`
2. Edit `ios-app/ios/App/App.xcodeproj/project.pbxproj` manually to add the file
   to 4 places: PBXBuildFile, PBXFileReference, PBXGroup `504EC3061FED79650016851F`
   (App group children), and PBXSourcesBuildPhase `504EC3001FED79650016851F`
   (Sources files list). Use unique hex IDs.
3. Capacitor 7 SPM builds do NOT auto-discover plugins living in the App target
   — they must be manually registered. Pattern:
   `MainViewController.swift` subclasses `CAPBridgeViewController`, overrides
   `capacitorDidLoad()` to call `bridge?.registerPluginInstance(MyPlugin())`,
   and the storyboard `Base.lproj/Main.storyboard` points its initial VC at
   this subclass (`customClass="MainViewController" customModule="App"`).
4. The compiled main `App` binary is a stub; real Swift code is in
   `App.debug.dylib` next to it. iOS loads the dylib automatically.

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
| `/api/home?feed=recommended` | YouTube browse API (`FEwhat_to_watch`, cookies) with continuation for infinite scroll | yt-dlp fallback (23 videos, no pagination) |
| `/api/home?feed=subscriptions` | yt-dlp subscriptions feed (Firefox cookies) | — |
| `/api/live` | yt-dlp home feed (live items) + youtube-sr | YouTube Data API enrichment |
| `/api/history` | YouTube browse API (cookies) + local `.history.json` | — |
| `/api/preview-url?id=VIDEO_ID` | yt-dlp `--get-url` for format 134/133/160/18 (360p/240p/144p) | — |

**Browse API for recommended feed**:
- Uses YouTube innertube browse API with `browseId: "FEwhat_to_watch"` + `?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8`
- **CRITICAL: only `.youtube.com` domain cookies work** — including `.google.com` cookies causes `CookieMismatch` redirect. `parseCookieFile()` already filters to youtube.com.
- Response contains both `richItemRenderer > videoRenderer` (with full metadata) and `richItemRenderer > lockupViewModel` (newer format — extract title, channel, views, duration from nested metadata)
- Duration extracted from accessibility label regex: `"label":"(N hours?, )?(N minutes?, )?(N seconds?)"`
- Views extracted from metadata text: "2.7K views", "5.3K watching" etc
- Continuation tokens from `continuationItemRenderer > continuationEndpoint > continuationCommand > token`
- Shorts separated: `shortsLockupViewModel` items + videos ≤180s duration → `shorts` array in response
- Shorts section rendered as horizontal scrollable row after first 24 videos
- Background enrichment via YouTube Data API (non-blocking, updates cache for next load)

YouTube Data API quota is 10,000 units/day. Search costs 100 units per call. Always prefer youtube-sr for search.

### Auth & YouTube History

- YouTube browse API for history uses Firefox cookies (SAPISID + SAPISIDHASH auth) — no OAuth needed
- `parseCookieFile()` reads `cookies.txt` (Netscape format), `sapisidHash()` computes the auth header
- YouTube history now uses `lockupViewModel` renderer (not `videoRenderer`) — extract `contentId`, `title`, `channel` from nested metadata, `startPercent` from `thumbnailOverlayProgressBarViewModel`
- OAuth (optional): scope `youtube.force-ssl`, tokens in `.tokens.json`, auto-refreshed
- OAuth client shared with the `/dev/hk` project (Nest integration)
- Redirect URI: `http://localhost:3000/oauth/callback`

### mpv Playback

- Spawned with `--input-ipc-server=/tmp/mpv-socket` + `--keep-open` + `--ytdl-raw-options=cookies=cookies.txt` + `--audio-samplerate=48000` + `--autosync=30` (prevents A/V drift on long playback)
- Unix domain socket sends JSON commands: `{"command": ["get_property", "time-pos"]}`
- mpv keeps the socket open — read first complete JSON line with `request_id`, then close
- New videos loaded via `loadfile` IPC command (reuses existing window/position) — only spawns new mpv if no existing player
- Playback position saved every 10s to `.history.json`, also saved on stop and before switching videos
- Progress saved to `nowPlaying` (not captured URL) to prevent cross-video corruption
- Videos only added to history after confirming they loaded (duration > 0); removed if mpv crashes within 5s
- `progressInterval` uses a generation counter (`progressGen`) to prevent overlapping intervals from rapid play requests
- `startProgressTracking(url)` captures the URL at setup time to prevent saving progress to the wrong video
- Cross-device resume: local `.history.json` position takes priority; falls back to `watchPct` from YouTube history API → mpv `--start=N%` (percentage-based seek). Frontend sends `video.startPercent` in play request.

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

- Phone plays the same video as the desktop player, synced via mpv position
- **All streams use mpv** — live streams play via mpv (not VLC) for precise `time-pos` sync. VLC only used when explicitly switching for DVR via `/api/switch-to-vlc`.
- **Unified sync path (VOD + live)**:
  - Phone gets direct YouTube URL from `yt-dlp --get-url` (MP4 for VODs, HLS for live)
  - `clockOffset` (server-client clock diff) measured via ping/pong, recalibrated every 5min. **Critical sign: `Date.now() + clockOffset - serverTs`** (not minus — clockOffset = serverClock - clientClock, so adding converts client time to server time).
  - Drift = interpolated mpv position - phone currentTime. Hard-seek at 0.2s threshold with 5s cooldown, +0.5s seek latency compensation.
  - Safari ignores `playbackRate` on both MP4s and live HLS — only hard-seeks work.
  - Follows desktop scrubs (>5s position jump detection) and pause/resume.
  - Detects video switch on desktop (`pb.url` change) — full state reset + stream reload with 2s settle.
- **`phoneActive` flag**: tracks whether phone sync is active. Prevents mpv window from showing on unpause. Synced with eye icon visibility toggle and cmux focus toggle.
- **mpv window hidden** during phone sync via AppleScript `set visible of process "mpv" to false` (not `vid=no` which drops audio). Restored on phone close with aerospace focus + maximize restore.
- **Offset buttons (±1s, ±5s)**: seek phone directly for manual fine-tuning of live streams.
- **Video swap**: sync loop detects `pb.url` change, resets all sync state, re-fetches stream URL from `/api/watch-on-phone`.
- **iOS Safari limitations**: no MSE (can't use hls.js), ignores `playbackRate` on live HLS, seeks snap to 2s keyframe boundaries.
- **Live stream server-side detection**: if frontend doesn't send `isLive` flag, server checks via `yt-dlp --print is_live`
- Phone player positioned below Dynamic Island (`env(safe-area-inset-top)`)
- iOS lock screen media controls via Media Session API (`useMediaSession` hook) — silent audio loop (`public/silent.m4a`), checks mpv pause state before toggling to prevent double-toggle.
- **PTS-based vlcPdtEpochMs**: `fetchPdtFromUrl` extracts PTS from MPEG-TS segment headers for accurate PDT mapping (replaces imprecise `mediaSequence * avgSegDuration`). Used for VLC absolute time when VLC is active.

### Frontend (React)

- React + Zustand + Vite. Source in `client/src/`, build output in `client/dist/`
- Responsive: mobile list layout (<768px) + desktop grid layout (768px+) with hover preview
- **Afterglow terminal theme**: `--bg: #282828`, `--text: #ebdbb2` (warm cream), `--text-dim: #a89984`, `--green: #8ec07c`, `--red: #ac4142`, `--yellow: #e5b567`, `--blue: #6c99bb`. All colors as CSS variables in `:root`. Context menus use darker `#151515` bg.
- **Two font sizes** via CSS variables: `--font-lg: 14px` (primary), `--font-sm: 14px` on desktop / `10px` on mobile (currently same everywhere)
- **All SVG icons**: 16x16, stroke-based, `strokeLinecap="square"` + `strokeLinejoin="miter"` for consistent brutalist style
- Now-playing bar (`NowPlayingBar.jsx`): fixed bottom, uses `useShallow` selector for granular re-renders. Shows channel name + (player) instead of "Now playing".
- WebSocket (`/ws/sync`): server pushes playback state every 1s (position, duration, title, channel, monitor, windowMode, visible, paused, isLive, player, macStatus). Clock offset recalibrated every 5min.
- **Status dots** in header (4 dots, tap opens secret menu): WebSocket, Ethernet (en3), Mac lock, Screen on/off
- **Mac status**: polled server-side every 10s (`refreshMacStatus`), cached in `_macStatusCache`, included in WS broadcast (no client-side HTTP polling)
- **Now-playing bar icons**: eye icon (green=visible/red `#d05050`=hidden, tap toggles mpv visibility), terminal icon with window frame (green=cmux focused/gray=not, tap toggles cmux/mpv focus)
- **Refresh FAB**: fixed bottom-right above now-playing bar, long-press opens secret menu
- **Secret menu** (status dots or long-press refresh): labeled status indicators (WS, ETH, UNLK, SCR), volume slider (persists in UI store, ignores events >20px outside area), mute toggle (red when muted), audio output selector (SwitchAudioSource), toggle resolution, refresh cookies, focus cmux, lock Mac, close. Uses darker `#151515` background.
- `touch-action: manipulation` on `*` to prevent double-tap zoom
- YouTube URL pasted in search box auto-plays immediately
- **Search bar replaces logo** in header — left-aligned text, no background
- **Tabs**: Rec (recommended), Subs (subscriptions), Live, History
- **Long-press context menu on thumbnails only** (not whole card): "More from [channel]", "Copy link", "Close" — positioned above tap point, clamped to viewport, clear of bottom bar. Thumbnails have `-webkit-touch-callout: none` to prevent iOS selection.
- **Video preview on scroll/hover**: IntersectionObserver (mobile, center 40% of viewport) or mouseEnter (desktop) triggers `/api/preview-url` fetch → inline muted `<video>` overlay on thumbnail. Preview URL cached server-side (50 entries). Live videos excluded.
- **Shorts section**: horizontal scrollable row inserted after first 24 videos. Videos ≤180s auto-detected as shorts. Dedicated `shortsLockupViewModel` items also collected. ShortCard component with hover preview.
- Seek preview: storyboard thumbnails from YouTube sprite sheets (page URL template `M$M.jpg`, proper `backgroundSize` scaling) + time bubble. Live streams show time-behind-live.
- Recommended feed: infinite scroll with 800px rootMargin prefetch, 24 videos per page via browse API continuation
- Video badges: `duration` field can be pre-formatted string ("16:27"), "LIVE", or "SOON" — VideoCard handles all three
- **Thumbnail fallback**: uses `hq720.jpg` URLs from browse API; `onError` falls back to `hqdefault.jpg`
- History enriches all videos via YouTube API (duration, uploadedAt, channel, live status)
- Cookies exported from Firefox to `cookies.txt` on server startup (requires Mac to be unlocked)
- Firefox must be installed and logged into YouTube
- **Maximize detection on reconnect**: checks mpv window width vs screen width heuristic
- **cmux focus toggle**: aerospace-based, exits maximize when focusing cmux, restores on mpv focus. `phoneActive` synced to keep eye icon consistent.
- **Window resize on loadfile**: floating mode re-applies 38% width, 16:9 aspect, top-right position via AppleScript after video loads (prevents vertical shorts from stretching window). Maximize/fullscreen modes re-apply aerospace fullscreen.

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
