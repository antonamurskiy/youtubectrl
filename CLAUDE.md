# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

YouTubeCtrl — a local web app to browse/search YouTube on your phone and play videos on your computer via mpv. Single-user, runs on the local network at `yuzu.local:3000`.

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
- **Live Activity — DORMANT.** Widget extension target + Swift files
  remain in the Xcode project but the JS hook is unwired. Replaced by
  MPNowPlayingInfoCenter (less code, better OS integration). App.jsx
  calls `endLiveActivity()` once on mount to clean up stragglers from
  older installs. Don't re-add without a specific reason.
- **Deep link**: `youtubectrl://play?url=...` forwards to `/api/play` so a
  Shortcut can share YouTube URLs into the app.
- **Background audio**: Info.plist has `UIBackgroundModes=audio` and the
  audio session is `.playback / .moviePlayback`.

### Volume intercept — how it works

KVO-observe `AVAudioSession.outputVolume`. On each change with
|delta|≥0.005, emit a `volumeButton` event with ±3 step → JS POSTs
`/api/volume-bump` (debounced 30ms server-side) → osascript bumps Mac
volume. After each press, silently restore phone volume to 0.5 via
hidden `MPVolumeView` UISlider so the phone's own level doesn't drift.

To distinguish our restore from a user press: swallow an observation
only if it matches the restore target AND arrives within ~80ms of
`lastRestoreRequestedAt`. Earlier blanket `restoringVolume` flag was
too coarse — it dropped real user presses landing in the window.

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

Use the `xcodeproj` Ruby gem (`gem install --user-install xcodeproj`)
to edit `ios-app/ios/App/App.xcodeproj/project.pbxproj` — manual
editing is too error-prone. Place the file under
`ios-app/ios/App/App/` (or `Shared/` for files compiled into the
widget too). For plugins, register in `MainViewController`'s
`capacitorDidLoad()` and add `_ = MyPlugin.self` anchor in
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
- **Prefer cookie auth for new features.** OAuth is present but `.tokens.json` may not exist on every install, and cookies work for everything the YouTube web client can do. Pattern: `parseCookieFile()` + `sapisidHash()` + innertube endpoint (`/youtubei/v1/...`). Use OAuth only as a fallback when cookies refuse, or when the feature truly needs a Data API capability that innertube doesn't expose.
- **Cookie-based subscribe/unsubscribe**: `POST /youtubei/v1/subscription/{subscribe,unsubscribe}` with `{channelIds: [id], context, params: "EgIIAhgA"}` for subscribe. Response's `actions[].updateSubscribeButtonAction.subscribed` is authoritative — browse-cache propagation takes ~5s so don't trust a follow-up `/api/channel` read for UI confirmation.
- **Cookie-based subscription status**: parse `subscriptionStateEntity` records from a channel browse response. Each entity key is a base64 protobuf containing the channel id; match by substring of decoded bytes. The older `subscribeButtonRenderer.subscribed` field is NOT reliable on modern responses — it's a template, not state.

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
- **`--vo=null` fallback**: when the display is asleep (no WindowServer access), mpv IPC wedges after spawn with `--vo=gpu-next`. After a cheap-property-read timeout post-spawn, kill and respawn with `--vo=null` for audio-only playback. On next `/api/play`, if previous mpv was `--vo=null` and the display is now awake (or vice-versa), `voMismatch` triggers a respawn instead of reusing.

### Live stream DVR — READ THIS BEFORE TOUCHING

Live + DVR + post_live all play through **streamlink piped into mpv's
stdin**. VLC is gone. ffmpeg's HLS demuxer is gone too (it can't seek
past its tiny live cache). This section is load-bearing — every piece
matters.

#### The core limitation we worked around

ffmpeg's HLS demuxer clamps `seekable-ranges` to whatever segments are
currently buffered (~15-30s) on live manifests, regardless of cache
size flags. mpv-direct-on-HLS therefore can't DVR-scrub past its
buffer. Tested with mpv 0.41 + ffmpeg 8.1 in April 2026 — still
broken. So we don't let mpv touch HLS directly for live.

#### The streamlink-piped solution

streamlink reads `/api/hls-live.m3u8` (which injects
`#EXT-X-PLAYLIST-TYPE:EVENT` so streamlink honors `--hls-start-offset`
— without that tag streamlink ignores the offset and always starts at
edge). streamlink streams MPEG-TS into mpv's stdin. From mpv's
perspective it's just an infinite stream — no HLS demuxer involved,
no seekable-range clamping.

Server-side state:
- `currentLiveHlsUrl` — upstream YouTube HLS manifest URL
- `streamlinkProcess` — child process feeding mpv's stdin
- `liveOffsetSec` — current `--hls-start-offset` (0 = live edge,
  >0 = DVR scrubback). Single source of truth for "where is mpv in
  the DVR window."
- `isPostLiveStream` — true when yt-dlp reports `live_status=post_live`
  (just-ended broadcast that's not yet a regular VOD). Treated like
  live but `liveOffsetSec` is seconds-from-start, not behind-live.

#### How a scrub-back works

1. Frontend sends `POST /api/seek { position }` where `position` is in
   scrubber-space (0 to `lastManifestFullDuration`, live edge at right).
2. Server computes `newOffsetSec = lastManifestFullDuration - position`
   (or `position` directly for post_live).
3. If target is within mpv's current forward/backward buffer: direct
   `seek` within mpv. No skip.
4. Else: `respawnLivePipeline(newOffsetSec)` — kill streamlink+mpv,
   spawn fresh streamlink with `--hls-start-offset=newOffsetSec`,
   pipe into a new mpv. **One skip.** Anchor recorded.

`/api/go-live` respawns with offset=0 to swap back to live edge.

#### Scrubber math — the anchor system

mpv's `time-pos` on a streamlink-piped stream is "seconds since
streamlink started feeding," NOT an absolute DVR position. The
scrubber UI needs absolute position in the DVR window. Solve with an
anchor captured at each seek:

```
subProxyAnchor = {
  wallMs: Date.now(),            // wall clock at seek
  mpvPosAtAnchor: <captured>,    // mpv's time-pos at seek (polled async, can take ~2s)
  behindLive: <requested>,       // newOffsetSec at seek moment
  userPdtAtAnchor: <PDT ms>,     // user's intended content PDT at seek
}
```

Each WS broadcast tick:
```
wallElapsed = (Date.now() - anchor.wallMs) / 1000
playElapsed = mpv_time_pos - anchor.mpvPosAtAnchor
behindLive  = anchor.behindLive + (wallElapsed - playElapsed)
scrubPos    = lastManifestFullDuration - behindLive
```

Playback at 1x → wallElapsed == playElapsed → behindLive constant
(thumb stays put). Paused → playElapsed == 0 → behindLive grows at 1x
(thumb drifts left as live advances).

Anchor capture is **async** — mpv takes up to ~3s to report a valid
`time-pos` after a respawn. Pre-seed `mpvPosAtAnchor=0` so the
scrubber doesn't flash, then refine once mpv reports a non-zero
time-pos (poll every 100ms up to 40 times). `userPdtAtAnchor` stays
pinned to the user's intended PDT.

Anchor cleared automatically when `liveOffsetSec === 0` (back at live
edge).

#### UI layer

- **Scrubber shows `lastManifestFullDuration`** even when mpv is on
  live-proxy (where mpv's raw duration is 20s). Server lies: the WS
  broadcast reports `duration = lastManifestFullDuration` and computes
  `position` via the anchor or cache offset. Frontend consumes these.
- **Time displays (`NowPlayingBar`)**:
  - Left position span: `-${formatTime(liveTimeBehind)}` (or `LIVE`
    if <5s). Never shows raw position number for live streams — that
    reads as "stream has been going for N hours" which is misleading
    for a rolling DVR.
  - Right duration span: blank for live streams.
  - Center badge: `LIVE` in red when at edge, `GO LIVE` in dim gray
    when scrubbed back. Tap → `/api/go-live` (swap back to live proxy
    if on sub, then seek to live edge).

#### /api/play lifecycle

For `isLive: true` (or `post_live`):
1. `yt-dlp -f 301/300/96/… --get-url` resolves the upstream HLS URL →
   `currentLiveHlsUrl`. Detect post_live via `yt-dlp --print live_status`.
2. Wipe `subProxyAnchor`, `playbackAnchor`, `liveOffsetSec`.
3. `startMpvPdtTracking(url)` — PDT tracking + `manifestStatsRefresh`
   (polls manifest every 10s to keep `lastManifestFullDuration` and
   `lastManifestEdgeEpochMs` fresh).
4. Synchronous `fetchManifest()` once now — primes
   `lastManifestFullDuration` before user can scrub.
5. `spawnStreamlink(url, 0)` → mpv reads from streamlink stdout. Zero
   skips for normal watching.

#### Things we tried that DON'T work (do not re-litigate)

- **mpv directly on YouTube HLS** — ffmpeg's HLS demuxer clamps
  seekable-ranges to its tiny cache regardless of cache flags.
- **VOD/EVENT tag without ENDLIST** — still treated as live (clamped).
- **`--demuxer-max-back-bytes=2048M`** alone — cache grows but ffmpeg
  still clamps `seekable-ranges` to its own calculated live window.
- **Reload on approach to EOF** (old `mpvLiveReload` every N min) —
  causes periodic visible skips. streamlink-piped never EOFs.
- **`mpvPdtEpochMs + time_pos * 1000` for "behind live"** — mpv's
  time-pos on a streamlink stream is local to streamlink's start, not
  stream-epoch PTS. Use the anchor system.
- **`/api/hls-sub.m3u8?behind=N`** — as live edge advances, the trim
  window shifts and mpv's cached segments renumber underneath.
  `time-pos` goes BACKWARD. (The from_seq variant of that endpoint
  still exists but isn't on the primary scrubback path.)

#### Relevant state

- `currentLiveHlsUrl` — upstream YouTube HLS URL. Set by `/api/play`.
- `streamlinkProcess` — current streamlink child piping into mpv.
- `liveOffsetSec` — current `--hls-start-offset` (0 = at live edge).
- `isPostLiveStream` — recently-ended broadcast flag.
- `lastManifestFullDuration` — DVR window size (seconds). Refreshed
  by `/api/hls-live.m3u8` fetches + 10s interval.
- `lastManifestEdgeEpochMs`, `lastManifestFetchedAt` — live edge PDT
  + when captured.
- `lastManifestTargetDur` — `#EXT-X-TARGETDURATION` (segment length).
- `subProxyAnchor` / `playbackAnchor` — see "Scrubber math" above.
- `mpvPdtEpochMs` — stream-epoch wall-clock; captured but not
  actively used for sync (kept for potential debugging).

#### Relevant endpoints

- `GET /api/hls-live.m3u8` — proxy that injects EXT-X-PLAYLIST-TYPE:EVENT
  (so streamlink's --hls-start-offset is honored). streamlink reads this.
- `POST /api/seek { position }` — scrubber-space seek, may respawn streamlink
- `POST /api/go-live` — respawn streamlink at offset=0
- `GET /api/_debug/sync` — dumps all the state above; first stop for
  "why is sync broken"

### AeroSpace Integration

- mpv `floatTopRight()` now sets `aerospace layout floating` + `ontop` (was missing `layout floating`)

- mpv rule: `layout floating` with `check-further-callbacks = false` — aerospace can't switch mpv to tiling
- Monitor 1 (Built-in/laptop) = workspace 8, Monitor 2 (LG UltraFine) = workspace 1
- Three window modes tracked server-side (`windowMode`): `floating`, `maximize` (aerospace fullscreen with dock), `fullscreen` (native)
- Floating: top-right corner, always-on-top (mpv only), auto-hides on pause
- Moving between monitors: mpv uses fullscreen bounce
- **mpv maximize**: `aerospace fullscreen --no-outer-gaps on/off` works directly on floating windows
- Find window IDs: `aerospace list-windows --all | grep mpv`

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
- **All streams: Mac uses mpv** — VODs play directly; live + post_live play via streamlink piped into mpv (see Live stream DVR section). Phone gets the upstream YouTube manifest URL directly (no proxy).
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
   HLS manifest URL (format 301/300/96/…). Store it in `currentLiveHlsUrl`
   and kick off `startMpvPdtTracking(hlsUrl)`.
2. **`capturePdtEpoch(hlsUrl)`** fetches the manifest, reads the first
   `#EXT-X-PROGRAM-DATE-TIME` tag, fetches the first ~10KB of the first
   segment, extracts the MPEG-TS PTS via `extractFirstPts()` (reads TS
   packet headers — 33-bit PTS divided by 90000 to get seconds). The
   stream epoch is `pdtMs − segPts * 1000` — i.e., the wall-clock at
   which PTS=0 would have occurred. This epoch is stable across
   manifest refreshes as long as the stream doesn't discontinue.
3. **Refresh every 60s** via `mpvPdtRefreshInterval`. Recalibrates
   against the current `currentLiveHlsUrl` so encoder clock skew and
   manifest PDT re-anchors don't accumulate.
4. **Also called from `/api/watch-on-phone`** when the phone hands
   off — that endpoint *replaces* `currentLiveHlsUrl` with its own freshly
   resolved URL, which used to orphan PDT tracking. The explicit
   `startMpvPdtTracking` call there re-targets to the new URL.
5. **Also called on reconnect** in the server startup path — if mpv is
   already playing a live stream when the server restarts, we
   re-resolve and re-track. Without this, server restart leaves
   `mpvPdtEpochMs=0` until the user triggers `/api/play` again.
6. **Broadcast**: in the `/ws/sync` playback tick for streamlink-piped
   mpv (live or DVR-scrubbed):
   ```
   liveEdgeNow   = lastManifestEdgeEpochMs + (Date.now() - lastManifestFetchedAt)
   behindLiveSec = (liveOffsetSec === 0)  mpvDur - timePos
                 | (liveOffsetSec  >  0)  anchor.behindLive + (wallElapsed - playElapsed)
   absoluteMs    = liveEdgeNow - behindLiveSec * 1000 + syncOffsetMs
   ```
   This gives the wall-clock PDT of the frame mpv is currently showing
   (what the phone's `AVPlayerItem.currentDate()` also reports).
   `phoneSyncOk: true` when we have valid manifest-edge stats.

   **Do NOT use `mpvPdtEpochMs + timePos * 1000` here.** mpv's
   `time-pos` on a streamlink-piped stream is local to streamlink's
   start, not stream-epoch PTS. Empirically wrong by many hours for
   long-running streams.

   `mpvPdtEpochMs` is still captured by `startMpvPdtTracking` for
   potential debugging use but nothing actively reads it for sync.

7. **Stable anchor**: rather than computing `behindLiveSec` fresh each
   WS tick (which bounces ~5s every time mpv fetches a new cache
   chunk), capture `playbackAnchor = { mpvPosAtAnchor, userPdtAtAnchor }`
   once per stream (as soon as mpv reaches steady state:
   `reportedDur > 5 && timePos > 1`). Then
   `user_pdt_now = userPdtAtAnchor + (mpv_pos_now - mpvPosAtAnchor) * 1000`.
   Monotonic at 1x, phone's drift converges cleanly instead of chasing
   cache-growth noise.

8. **MPV_DISPLAY_LAG_MS = 3 × TARGETDURATION × 1000** subtracts from
   userPdtAtAnchor to correct for streamlink's HLS live-buffer offset.
   streamlink defaults to `--hls-live-edge=3` (same convention as
   ffmpeg's `live_start_index=-3`) — output is always 3 segments
   behind real live edge as a safety margin. Three segments in
   **time** varies per stream:
   - lofi (5s segments) → 15 000 ms lag
   - sl4m + many others (2s segments) → 6 000 ms lag

   Parsed from `#EXT-X-TARGETDURATION` in
   `updateManifestStatsFromText`, stored in `lastManifestTargetDur`.
   Refreshes on every live-proxy fetch + the 10s periodic refresh.
   Default 5s until first parse.

   **Do NOT hardcode this value.** We did (1500ms) and phone sync
   drifted wildly on streams whose segment length wasn't 0.5s. A
   hard-coded live-buffer lag will always be wrong for most streams.

   **Frame rate (30fps vs 60fps) does NOT matter for sync.** All math
   is PDT / wall-clock seconds, not frame indices. mpv's `time-pos`
   is seconds, phone's `AVPlayerItem.currentDate()` is a Date. The
   seek-to-date path lands on a keyframe (GOP-dependent), not a
   specific frame. fps only affects visual jitter during scrubs.

9. **No auto-calibration of the offset.** Tempting to try, but phone's
   drift converges to 0 by construction (phone seeks to match reported
   mpv_pdt), so there's no feedback signal for an auto-tuner. Attempted
   several ways; none work without external ground truth that we don't
   have. Don't re-try this — it's the kind of problem that looks
   solvable until you spend half a day on it and realize the math is
   circular.

10. **Manual sync-offset slider** (`SyncOffsetSlider` in
    `SecretMenu.jsx`): native `<input type=range>` with range ±8000ms,
    step 100ms. On drag, POSTs `/api/sync-offset`. Server adds the
    value to broadcast `absoluteMs`. Persisted to `.sync-offset.json`
    (gitignored) and restored on server boot — tune it once per stream
    type, don't have to re-do after every restart.

11. **Tuning direction**: if phone plays CONTENT *ahead of* what mpv
    shows, lower the offset (slider left). If phone is *behind* mpv,
    raise it. The value is added to reported `mpv_pdt`; higher value
    → phone seeks further forward → phone closer to live. Typical
    good values live in ±1-2s range; -3s to +3s is the sweet spot

12. **Two anchor systems, one per offset mode** — see the scrubber
    section for the full writeup, but the short version for sync:
    - `playbackAnchor` (`liveOffsetSec === 0`): captured from
      cache-offset once at steady state. Includes `MPV_DISPLAY_LAG_MS`
      subtraction.
    - `subProxyAnchor` (`liveOffsetSec > 0`, = DVR-scrubbed): captured
      at seek time with `userPdtAtAnchor = liveEdgeAtSeek - behindLive * 1000`.
      **Do NOT derive userPdt from `liveEdgeNow - behindLive * 1000`
      each tick** — liveEdgeNow jitters ~1s on every 10s manifest
      refresh because YouTube's edge doesn't advance perfectly
      linearly, and phone sync chases every jitter. Instead use
      `userPdtAtAnchor + (mpv_pos_now - mpvPosAtAnchor) * 1000`. This
      pattern fails silently with drifting-but-not-obviously-broken
      sync — confirmed via logging and a painful afternoon.

13. **Drop outlier drift samples from the EMA.** Phone's
    `AVPlayerItem.currentDate()` returns stale values while the HLS
    stream first loads, producing drift readings like 7000s+. Feeding
    those into the 5-sample EMA polluted it for multiple ticks even
    after phone successfully seeked to match. Guard in
    `PhonePlayer.jsx`: `if (Math.abs(drift) < 10) samples.push(drift)`.
    Raw drift still drives the forced seek decision (so we don't miss
    big initial corrections), but the displayed/smoothed drift
    converges cleanly.

14. **Rate button shows live mpv speed.** The `2×` button in
    `NowPlayingBar` renders mpv's actual `speed` property, broadcast
    via WS. At 1.0 it shows `1×`, during hold `2×`, off-1.0 shows in
    red (e.g. `0.97×`). Whenever `syncVod` rate-nudging bugs out and
    leaves mpv at a non-1 speed, it's visible at a glance. Also reset
    to 1.0 on every streamlink respawn (`/api/play`, `/api/seek` past
    cache, `/api/go-live`) and VOD `loadfile`.

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

`stopMpvPdtTracking()` zeros `mpvPdtEpochMs` and clears the refresh +
live-reload intervals. Called from:
- `/api/stop` (user stopped playback)
- `/api/play` with `isLive=false` (new VOD)
- mpv-liveness monitor on IPC failure

Without these, stale `mpvPdtEpochMs` could bleed into the next stream
and wreck its sync.

#### Debug endpoints

- `GET /api/_debug/sync` — dumps `activePlayer`, `nowPlaying`,
  `currentLiveHlsUrl`, `mpvPdtEpochMs` (+ISO string), and refresh-active
  flag. First stop for "why is sync broken."
- `POST /api/client-log` — appends JSON lines to `/tmp/ytctl-client.log`.
  The `DEBUG_SYNC_LOG` flag in `PhonePlayer.jsx` gates the client-side
  ticker; flip it to `true`, rebuild, and you get every drift/seek/
  calibration event. Invaluable for debugging convergence issues.

- **PTS-based PDT**: `capturePdtEpoch` extracts PTS from MPEG-TS segment
  headers for accurate PDT mapping (avoids imprecise `mediaSequence ×
  avgSegDuration` fallback).

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
- **Secret menu** (status dots or long-press refresh): labeled status indicators (WS, ETH, UNLK, SCR), volume slider, mute toggle, audio output selector (SwitchAudioSource), focus cmux, lock Mac. **Misc submenu** (collapsed): brightness slider (drives display mpv is on, via custom Swift `bin/brightness` binary), toggle resolution, refresh cookies, sync-offset slider, close. Uses darker `#151515` background.
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
- `activePlayer` — server-side variable: `'mpv'` | `null`
- `currentLiveHlsUrl` — upstream YouTube HLS URL for the live stream currently playing (read by streamlink via `/api/hls-live.m3u8` and by PDT tracking)
- `bin/brightness` — Swift binary compiled on server boot from `bin/brightness.swift`, drives the active display's brightness for the Misc-submenu slider
- `public/silent.m4a` — truly silent 5-minute m4a for iOS Media Session (must be actual silence, not low volume — iOS drops session at volume=0)
