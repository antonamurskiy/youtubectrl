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

## iOS app (Vids) — Swift + Capacitor shell

The iOS app is a Capacitor 7 WebView wrapper over the same React app, plus
a native Swift plugin (`NativePlayerPlugin`) that handles things the web
layer can't (PiP, background audio, lock-screen Now Playing,
hardware-volume-button interception, Live Activity). Display name is
**Vids**, bundle id `com.antonamurskiy.ytctl1289`.

### Layout

```
ios-app/
  capacitor.config.json              # points WebView at yuzu.local:3000
  package.json                       # @capacitor/* plugins
  ios/App/
    App.xcodeproj/                   # Xcode project
    App/
      AppDelegate.swift              # audio session setup, youtubectrl:// URL
      MainViewController.swift       # CAPBridgeVC subclass that registers plugin
      NativePlayerPlugin.swift       # main native bridge (~1000 LOC)
      Info.plist
      Assets.xcassets/               # AppIcon + Splash
      Base.lproj/                    # LaunchScreen + Main storyboards
    Shared/                          # files compiled into BOTH App + Widget targets
      YouTubeCtrlActivityAttributes.swift
      YouTubeCtrlIntents.swift       # AppIntents for widget buttons
    YouTubeCtrlWidget/               # Widget Extension target (Live Activity)
      YouTubeCtrlWidgetBundle.swift
      YouTubeCtrlLiveActivity.swift
      Info.plist
```

### Native capabilities

- **Picture-in-Picture** via `AVPictureInPictureController` on an
  `AVPlayerLayer`. Starts auto-on-background on iOS 14.2+.
- **Inline video rendering**: the same AVPlayerLayer is positioned over the
  WebView to match an HTML `<video>` placeholder (rect synced every frame
  via `setLayerFrame(x,y,w,h,visible)`). Only one player exists — the HTML
  video has no src on native; AVPlayer drives everything.
- **1080p + high-quality audio**: phone-only mode pulls separate DASH
  video (137) and audio (140) URLs from yt-dlp, builds an
  `AVMutableComposition` client-side with both tracks. Progressive format
  22 (720p single URL) is the fallback for seek reliability — DASH URLs
  hit a YouTube byte-range cap past a certain offset.
- **Lock-screen Now Playing** via `MPNowPlayingInfoCenter`. Artwork fetched
  async. `MPRemoteCommandCenter` wires the lock-screen play/pause, skip
  ±15, and scrub controls to the web app's control paths.
- **Hardware volume buttons** drive Mac volume (3% steps). Implemented by
  KVO-observing `AVAudioSession.outputVolume`, computing delta against the
  last observed value, emitting a `volumeButton` event to JS, and silently
  restoring when the phone value drifts to edges (15/85%). Only active
  when `playing && !phoneOnlyUrl` — in phone-only mode, volume buttons
  control the phone natively.
- **AirPlay route picker** via a hidden `AVRoutePickerView` whose button we
  programmatically trigger.
- **Keep-awake** via `UIApplication.isIdleTimerDisabled` while playing.
- **Live Activity (lock screen widget)** via the `YouTubeCtrlWidget`
  extension — shows artwork + title + ±10% volume buttons + play/pause.
  Taps are `AppIntents` that update the Activity's `ContentState`
  optimistically (read-modify-write from `Activity.activities`) then POST
  the server in a detached Task. Position isn't pushed (iOS rate-limits
  updates to ~1/sec without APNs push).
- **Deep link**: `youtubectrl://play?url=...` forwards to `/api/play` so a
  Shortcut can share YouTube URLs into the app.
- **Background audio**: Info.plist has `UIBackgroundModes=audio` and the
  audio session is `.playback / .moviePlayback`.

### Volume intercept — how it works

1. `AVAudioSession.outputVolume` is KVO-observed.
2. On change, compute `delta = newValue - lastObservedVolume`. Store new
   as `lastObservedVolume` unconditionally.
3. If `|delta| < 0.005`, ignore (iOS noise).
4. Emit `volumeButton` event with `±3` (fixed step). JS side POSTs
   `/api/volume-bump` which debounces osascript calls 30ms server-side.
5. After every press, silently restore phone volume to the 0.5 baseline
   via the hidden `MPVolumeView`'s UISlider — the phone's own volume
   should not drift while the app is controlling the Mac.
6. Distinguishing our restore from a user press: an observation is
   swallowed only if it matches baseline AND arrives within ~80ms of
   when we requested the restore (`lastRestoreRequestedAt`). The earlier
   blanket `restoringVolume` flag dropped *any* observation during the
   window — including real user presses — which is why we previously
   only recentered at the edges. The match-target + time-window check
   narrows the race to the rare case where a physical press happens to
   land exactly on baseline within 80ms of our restore.

### Live Activity — known constraints

- iOS throttles activity updates to ~1/sec from a backgrounded app. Push
  updates (APNs) would bypass this but require a paid Apple Developer
  Program account.
- Widget intents run in a **fresh process per tap** — no shared actor
  state persists. Don't rely on singletons for coalescing. Instead,
  read-modify-write the current `Activity.activities` content state
  directly inside `perform()`, then fire the server call as a detached
  `Task`.
- `ContentState` updates with partial data on the native side: the plugin
  merges incoming fields with `act.content.state` so JS can send only
  what changed (e.g. `{volume: 60}`) without clobbering the rest.

### Capacitor / Xcode project gotchas

- **Plugin discovery in Capacitor 7 SPM mode**: plugins living inside a
  Swift Package are auto-discovered, but plugins defined in the App
  target are NOT. Register them from a `CAPBridgeViewController` subclass
  (we have `MainViewController.swift`) overriding `capacitorDidLoad()` to
  call `bridge?.registerPluginInstance(MyPlugin())`. Main.storyboard's
  initial VC must be changed from `CAPBridgeViewController` /
  `customModule="Capacitor"` to `MainViewController` /
  `customModule="App"`.
- **Dead-code stripping**: the linker was dropping `NativePlayerPlugin`
  because nothing referenced it by name from Swift (Capacitor discovers
  via Obj-C runtime). Add `_ = NativePlayerPlugin.self` in
  `AppDelegate.didFinishLaunchingWithOptions` to anchor it.
- **Debug builds**: on Xcode 26+, the main `App` binary is a stub loader;
  the real Swift code is in `App.debug.dylib` next to it. iOS loads the
  dylib automatically. Don't panic if `nm App | grep NativePlayer`
  returns nothing — it's all in the dylib.
- **Widget Extension target** was added programmatically via the
  `xcodeproj` Ruby gem (`/tmp/add-widget-target.rb`). Adding extension
  targets by hand-editing `project.pbxproj` is too error-prone.

### Adding a new Swift file to the App target

1. Create the `.swift` file under `ios-app/ios/App/App/` (or `Shared/` if
   it should also be compiled into the widget).
2. Use the `xcodeproj` gem if available (`gem install --user-install xcodeproj`),
   or edit `ios-app/ios/App/App.xcodeproj/project.pbxproj` manually —
   add entries to: PBXBuildFile, PBXFileReference, the `App` PBXGroup
   (`504EC3061FED79650016851F`), and the Sources PBXSourcesBuildPhase
   (`504EC3001FED79650016851F`). Use unique hex IDs like
   `AABBCCDD00020000000000NN`.
3. If it's a plugin, remember to register it in `MainViewController`'s
   `capacitorDidLoad()` and add the `_ = MyPlugin.self` anchor in
   `AppDelegate`.

### Server lifecycle & macOS permissions

The server uses `blueutil` (Bluetooth) and `osascript` (Accessibility /
Automation) which require the parent process to have those grants in
System Settings. When the user runs `npm start` from their terminal
(iTerm / Warp / Terminal.app), those grants apply. Claude's own shell
inherits the Claude desktop app's grants — grant **Claude.app**
Bluetooth/Accessibility if Claude needs to start the server itself.

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
  - VOD drift = interpolated mpv position - phone currentTime. Hard-seek at 0.2s threshold with 5s cooldown, +0.5s seek latency compensation.
  - Live drift: see **Live Sync Architecture** section below — the VOD formula doesn't apply.
  - Safari ignores `playbackRate` on both MP4s and live HLS — only hard-seeks work.
  - Follows desktop scrubs (>5s position jump detection) and pause/resume.
  - Detects video switch on desktop (`pb.url` change) — full state reset + stream reload with 2s settle.
- **`phoneActive` flag**: tracks whether phone sync is active. Prevents mpv window from showing on unpause. Synced with eye icon visibility toggle and cmux focus toggle.
- **mpv window hidden** during phone sync via AppleScript `set visible of process "mpv" to false` (not `vid=no` which drops audio). Restored on phone close with aerospace focus + maximize restore.
- **Video swap**: sync loop detects `pb.url` change, resets all sync state, re-fetches stream URL from `/api/watch-on-phone`.
- **iOS Safari limitations**: no MSE (can't use hls.js), ignores `playbackRate` on live HLS, seeks snap to 2s keyframe boundaries.
- **Live stream server-side detection**: if frontend doesn't send `isLive` flag, server checks via `yt-dlp --print is_live`
- Phone player positioned below Dynamic Island (`env(safe-area-inset-top)`)
- iOS lock screen media controls via Media Session API (`useMediaSession` hook) — silent audio loop (`public/silent.m4a`), checks mpv pause state before toggling to prevent double-toggle.

### Live Sync Architecture (READ THIS BEFORE TOUCHING LIVE SYNC)

**This took a week to get right. Read in full before changing any piece.**

Syncing a live YouTube HLS stream between mpv on the Mac and AVPlayer on
the iPhone is fundamentally different from VOD sync. The VOD formula
(`mpv_position - phone_currentTime`) doesn't work because:

1. mpv and AVPlayer have independent HLS buffering, so each one picks
   a different "live edge" offset. Their `time-pos` values don't mean
   the same thing at the same wall-clock moment.
2. HLS live manifests ROLL — segments drop off the front every few
   seconds. A player's position in "stream seconds" drifts relative to
   wall-clock as the manifest window slides.
3. Safari-native HLS snaps seeks to keyframe (~2s) boundaries and
   ignores `playbackRate` on live streams. It can only coarsely seek.

**The solution: use the HLS `#EXT-X-PROGRAM-DATE-TIME` (PDT) tag as the
single sync currency.** Every HLS segment has a wall-clock timestamp
baked into its PDT tag. That timestamp is the same regardless of which
player is rendering the segment. So both sides convert their local
playback position to "the PDT of the frame I'm currently showing," and
drift becomes `mpv_PDT − phone_PDT` in real wall-clock milliseconds.

#### Data flow (server side, `server.js`)

1. **On `/api/play` with `isLive=true`**: yt-dlp resolves the direct
   HLS manifest URL (format 301/300/96/…). Store it in `lastVlcHlsUrl`
   and kick off `startMpvPdtTracking(hlsUrl)`.
2. **`capturePdtEpoch(hlsUrl)`** fetches the manifest, reads the first
   `#EXT-X-PROGRAM-DATE-TIME` tag, fetches the first ~10KB of the first
   segment, extracts the MPEG-TS PTS via `extractFirstPts()` (reads TS
   packet headers — 33-bit PTS divided by 90000 to get seconds). The
   stream epoch is `pdtMs − segPts * 1000` — i.e., the wall-clock at
   which PTS=0 would have occurred. This epoch is stable across
   manifest refreshes as long as the stream doesn't discontinue.
3. **Refresh every 60s** via `mpvPdtRefreshInterval`. Recalibrates
   against the current `lastVlcHlsUrl` so encoder clock skew and
   manifest PDT re-anchors don't accumulate.
4. **Also called from `/api/watch-on-phone`** when the phone hands
   off — that endpoint *replaces* `lastVlcHlsUrl` with its own freshly
   resolved URL, which used to orphan PDT tracking. The explicit
   `startMpvPdtTracking` call there re-targets to the new URL.
5. **Also called on reconnect** in the server startup path — if mpv is
   already playing a live stream when the server restarts, we
   re-resolve and re-track. Without this, server restart leaves
   `mpvPdtEpochMs=0` until the user triggers `/api/play` again.
6. **Broadcast**: in the `/ws/sync` playback tick for mpv-live,
   `absoluteMs = mpvPdtEpochMs + mpv.time-pos * 1000 + syncOffsetMs`
   — this is the *demux* PDT (mpv's internal decode position).
   Also sends `phoneSyncOk: true` when absoluteMs is available.

#### Data flow (native plugin, `NativePlayerPlugin.swift`)

1. **`getLiveState()`** returns `currentDateMs` (from
   `AVPlayerItem.currentDate()` — the PDT of the frame currently on
   screen, in epoch ms) plus `liveEdgeMs`, `position`, `duration`,
   `rate`, `paused`.
2. **`seekToDate({epochMs})`** uses `AVPlayerItem.seek(to: Date)`.
   Frame-accurate for HLS with PDT tags (MUCH better than Safari's
   keyframe-snap seeks). Returns `ok:false` if the target is outside
   the DVR window — AVPlayer silently clamps to nearest seekable
   range in that case, which is why early post-load seeks land at
   live edge and need another pass once the target comes into range.
3. **`automaticallyPreservesTimeOffsetFromLive = false`** on the
   `AVPlayerItem` — critical. With this left on, AVPlayer fights our
   seeks by drifting back to its own "N seconds behind live" target
   after every `seek(to: Date)`. We need AVPlayer to actually honor
   our seeks and stay where we put it.

#### Drift loop (client, `PhonePlayer.jsx`)

The sync interval ticks every 1 second. For `pb.isLive && pb.player ==='mpv'`:

```
mpvPdt    = pb.absoluteMs + elapsed              (server's demux PDT now)
phonePdt  = native.currentDateMs (cached, polled every 250ms)
drift     = (mpvPdt - phonePdt) / 1000           (positive = phone behind)
seekTarget = mpvPdt + seekBiasRef                (learned compensation)
```

- **`elapsed`** = `Date.now() + clockOffset - pb.serverTs`, clamped
  [0, 2000ms]. Accounts for WS latency + tick timing between when the
  server computed `absoluteMs` and when we read it.
- **`drift`** is reported as-is to the UI and over WebSocket — it's
  the honest mpv-vs-phone delta, NOT pre-compensated. Don't bake
  corrections into the drift reading itself; they belong in
  `seekBiasRef` only.

#### Self-calibrating bias (the key insight)

AVPlayer's `seek(to: Date)` lands on an HLS segment boundary, which
means it **undershoots** the requested Date by a player-dependent
offset (observed ~400–650ms, with per-seek jitter of ~±200ms). Apply
a static LAG constant and drift stabilizes at whatever the residual is
(≈ 0.4s). Not good enough.

The fix is a feedback loop: learn the undershoot from observed
post-seek drift and fold it into the next seek's target.

```
On each seek:
  calibPendingRef = true
  seekToDate(seekTarget)          // seekTarget = mpvPdt + seekBiasRef

Post-seek (≥2s after, 3+ stable drift samples within ±80ms):
  seekBiasRef += round(smoothedDrift * 1000 * 0.7)
  calibPendingRef = false
  (force another seek to apply the updated bias)
```

**Convergence behavior** (typical): drift starts at ~0.5s → bias grows
to ~400ms → drift drops to ~0.2s → bias grows to ~550ms → drift
oscillates through ±0.2s for 2–3 cycles as per-seek jitter averages
out → settles at |drift| < 0.05s. Takes 4–8 seeks, ~20–30 seconds.

**Knobs** (in `PhonePlayer.jsx`, sync interval):

- `70% learning rate` — aggressive enough to converge in a few cycles.
  Smaller rates (25%) technically avoid overshoot but converge too
  slowly and get stuck when seek threshold isn't tripped to re-test.
- `0.5s seek threshold` — below this the system is inside the AVPlayer
  jitter floor and additional seeks would bounce.
- `2.5s seek cooldown` — minimum time between seeks. HLS buffering
  needs time to settle before we can trust the post-seek measurement.
- **Force-seek after calibration**: `shouldSeek = calibrated || …`.
  Without this, once drift drops below 0.5s the loop stops seeking
  and the newly-learned bias never gets applied — drift stalls at
  whatever residual was first learned.
- `drift sample window = 5` for EMA smoothing; `variance bound = 80ms`
  to decide "stable."

**Things NOT to do** (tried, didn't work):

- ❌ Apply a static `LIVE_AUDIO_LAG_MS` bias directly to the drift
  value — it's a lie to the displayed number and doesn't converge.
- ❌ Recenter on every seek regardless of outcome with a small learning
  rate — converges too slowly because the loop stops seeking before
  the bias is fully learned.
- ❌ Let AVPlayer drift back to its `configuredTimeOffsetFromLive`
  target — the seeks work but AVPlayer pulls back afterwards.
- ❌ Use `rate` adjustments to close the drift gradually instead of
  hard seeking — AVPlayer live HLS ignores `rate` changes in
  practice. And Safari web ignores them too.
- ❌ Rely on `pb.position` (mpv `time-pos` in seconds) + phone
  `currentTime` as the sync currency. They're each offset from PDT
  by different constants depending on how each player initialized.

#### Lifecycle tear-down

`stopMpvPdtTracking()` zeros `mpvPdtEpochMs` and clears the refresh
interval. Called from:
- `/api/stop` (user stopped playback)
- `/api/switch-to-vlc` (phone handing off to VLC for DVR)
- `/api/play` with `isLive=false` (new VOD)
- mpv-liveness monitor on IPC failure

Without these, stale `mpvPdtEpochMs` could bleed into the next stream
and wreck its sync.

#### Debug endpoints

- `GET /api/_debug/sync` — dumps `activePlayer`, `nowPlaying`,
  `lastVlcHlsUrl`, `mpvPdtEpochMs` (+ISO string), refresh-active flag,
  and `vlcPdtEpochMs`. First stop for "why is sync broken."
- `POST /api/client-log` — appends JSON lines to `/tmp/ytctl-client.log`.
  The `DEBUG_SYNC_LOG` flag in `PhonePlayer.jsx` gates the client-side
  ticker; flip it to `true`, rebuild, and you get every drift/seek/
  calibration event. Invaluable for debugging convergence issues.

- **PTS-based vlcPdtEpochMs**: `capturePdtEpoch` (formerly
  `fetchPdtFromUrl`) extracts PTS from MPEG-TS segment headers for
  accurate PDT mapping (replaces imprecise
  `mediaSequence * avgSegDuration`). Shared between VLC and mpv PDT
  tracking — VLC uses `vlcPdtEpochMs`, mpv uses `mpvPdtEpochMs`.

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
