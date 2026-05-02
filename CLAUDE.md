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

# 2. Clean + build iOS for device (-allowProvisioningUpdates refreshes the cert)
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

### iOS lock-screen / Control-Center widgets and `keepalive`

When the user taps play/pause on the iOS lock-screen Now Playing
widget, the WebView is **backgrounded**. iOS aggressively cancels
in-flight `fetch()` requests on backgrounded webviews. Any handler
that POSTs to the server in response to a lock-screen widget tap
**must** use `fetch(..., { keepalive: true })` or the request never
goes out the wire — server-side state (mpv pause, hide, etc.) silently
desyncs from the iOS-side UI.

Hot paths that need `keepalive: true`:
- `useNativeNowPlaying.js` — `togglePlayPause`, `skip`, `seek` handlers
  for `remotePlay` / `remotePause` / `remoteTogglePlayPause` /
  `remoteSkip` / `remoteSeek` events from the native plugin
- `PhonePlayer.jsx` — both `phoneVideoCtrl.play` and
  `phoneVideoCtrl.pause` (sync-mode controls that toggle mpv via
  `/api/playpause`)

Symptom of missing keepalive: "I paused from lock screen and mpv
didn't hide on the Mac." (Server never saw the pause → mpv kept
playing → auto-hide-on-pause never fired.)

### APNs push (Claude prompts + kill-feed + health)

Real-time push from the Mac to the iPhone for:
- **Waiting prompts** — Claude asked a 1-of-N question. APNs banner
  with the question as title, numbered options as body, and N action
  buttons (`CLAUDE_PROMPT_2/3/4` categories registered at app
  launch). Long-press the banner → tap a digit → answer lands in
  Claude's prompt without bringing the app forward.
- **Turn done** — Claude finished a turn (state idle from non-idle).
  Throttled to one per 60s, body is the most recent feed line. Body
  is prefixed with the source tmux window name (`[main] Bash(...)`).
- **Health pings** — mpv crash with a known-bad reason
  (`Members-only video`, `Age-restricted`, etc.) or cookie-export
  failure. Title `Playback failed`.
- **Per-line kill-feed pushes were dropped** — too noisy. The phone
  only buzzes for things that need attention, not every Bash/Read.

#### Setup

- `.env` keys: `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
  `APNS_TOPIC` (bundle id), `APNS_PRODUCTION` (`false` for dev).
- The .p8 auth key sits at `.apns-key.p8` (gitignored).
- `App.entitlements` declares `aps-environment=development`.
  `CODE_SIGN_ENTITLEMENTS = App/App.entitlements;` is set on both
  Debug + Release in `project.pbxproj`. The Apple Developer
  Program account is paid (active as of 2026-05-01) — Push
  Notifications, App Groups, Background Modes, and other
  capabilities that Personal Teams can't sign all work.
- Server uses `@parse/node-apn`. Tokens persist to
  `.apns-tokens.json` (gitignored). Bad/Unregistered tokens
  auto-purge.
- See `APNS_SETUP.md` for the full activation checklist.

#### Action-button delivery flow

Action buttons use `options: [.foreground]` — iOS launches the app,
JS does the actual `/api/tmux-select` + `/api/tmux-send` fetches via
the live network context. **Tried `options: []` (silent) twice; both
failed:**
- `URLSession.shared` from `didReceive`: iOS killed the in-flight
  request before reaching the local server.
- `URLSessionConfiguration.background` (BackgroundTransferService):
  the upload completed, but iOS retried it on app foreground (the
  response wasn't delivered to the suspended app, so iOS treated
  it as in-flight), double-sending the digit.

The reliable path is `.foreground` action + JS fetch + a 5-second
key-based dedupe in `usePushTap.js`'s `handleTap` so the
`getPendingPushTap` cold-launch drain and the live `pushTap` event
can't both submit. AppDelegate stashes `(tmuxWindow, answer)` in
static vars + posts NSNotification `YTCtrlPushTap`; the plugin
forwards as a `pushTap` event to JS; `getPendingPushTap` is the
mount-time drain.

#### Capacitor delegate war

Capacitor's `@capacitor/local-notifications` plugin claims the
`UNUserNotificationCenter.delegate` slot AND replaces our registered
categories on plugin load, AFTER our `didFinishLaunchingWithOptions`
returns. Without reclaiming, our `didReceive` never fires and the
`CLAUDE_PROMPT_*` action buttons aren't shown. We re-set both in
`applicationDidBecomeActive` — runs after all Capacitor plugins
initialize, so we win the race.

#### Foreground UX

`willPresent` returns `[]` so APNs banners don't double up with the
in-app feed/quick-reply when the app is in front. Background and
lock-screen pushes still display normally (`willPresent` only fires
when the app is foreground).

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

### Native iOS app (`ios-native/Vids`) — separate target

The Capacitor shell at `ios-app/` is the dual-client web wrapper. The
PURE-NATIVE iOS app lives at `ios-native/Vids` (SwiftUI + `@Observable`
stores, no WebView). Same backend, different UI runtime. See the
`Dual clients kept` memory note — both stay.

#### VodSyncEngine

Sibling to `LiveSyncEngine`. Lives at `ios-native/Vids/Player/VodSyncEngine.swift`.
Started by `PhoneModeStore.switchToSync` when `resp.isLive == false`,
stopped on `switchToComputer` and on the live branch.

Algorithm (matches PhonePlayer.jsx VOD sync loop):
- 1Hz tick. `mpvPos = playback.interpolatedPosition(now: clockOffset:)`.
  `phonePos = host.currentTimeSeconds`. `drift = mpvPos - phonePos`.
- Hard-seek to `mpvPos + biasSec` when `|drift| > 0.2s` AND cooldown OK
  AND not settled. Settled = `|drift| < 0.15s` for 4 consecutive ticks
  (then freeze seeks — stops periodic micro-skip at steady state).
- Self-calibrating bias: `biasSec` starts at 0.5, updated by
  `drift × 0.7` each post-seek measurement (taken ≥2s after seek so
  AVPlayer has settled). Converges to AVPlayer's actual seek-settle
  latency in 2-3 cycles. Clamped to [-2, +5] seconds.
- Mirrors mpv pause/resume on AVPlayer (`pb.paused` → `host.pause/play`).
- 1.5s post-`start()` settle skip — early `currentTime` reads come back
  as 0 and would trigger phantom big-drift seeks back to start.
- Skips entirely when `pb.isLive` or `pb.duration <= 0` or paused.

State (strong refs to `host` / `playback` / `api`): `@Observable` types
under Swift 5.9 macros are unreliable as `weak` — the optional weak var
read as nil even with the underlying object alive. Engine lives for app
lifetime via ServiceContainer so retain cycles aren't a concern.

Diagnostic overlay: `SyncDiagnostics` shows `drift / seek / vod` for
VOD sessions and `drift / smooth / bias / seek / live` for live. Visible
only when `phoneMode.mode == .sync`.

Debug logging: every tick POSTs to `/api/client-log` (gated on
`debugLogging` const, default true). `tail -f /tmp/ytctl-client.log |
grep vodsync` shows live drift/bias/willSeek/calibrated state.

#### AVPlayer seek tolerance — read this

`AVPlayerHost.seek(toSeconds:)` MUST use a small tolerance, not
`.positiveInfinity`. With `±∞` tolerance AVPlayer lands on whatever
keyframe is "convenient" — anywhere in the video, often far from the
target. The bias-learning loop measures noise instead of latency and
never converges; user sees "seeks to wrong direction / random jumps".

Use `CMTime(seconds: 0.1, preferredTimescale: 600)` for both
`toleranceBefore` and `toleranceAfter`. Strict zero can fail on streams
without fine-grained byte-range seeks (Rumble), but ±100ms is safe and
keeps VOD sync convergent.

LiveSyncEngine seeks via `AVPlayerItem.seek(to: Date)`, which is
PDT-frame-accurate by construction (HLS `#EXT-X-PROGRAM-DATE-TIME`
tags) — no tolerance issue there.

#### History tab refresh on play

`FeedStore` caches each tab's videos and only reloads on `tab.activate`
or pull-to-refresh. Without an explicit invalidation, a just-played
video doesn't move to the top of History until the user re-opens the
tab. Hook in `RootView.onChange(of: playback.url)`:
```
Task { await feed.load(tab: .history, api: services.api) }
```
runs alongside `phoneMode.reloadForCurrentVideo` on every URL change.

Server-side `/api/history` builds a unified-recency timeline: each
YouTube history entry gets a synthesized timestamp from its YT-feed
position (`now - i*60s`), overridden by `historyMap[url].timestamp`
when present. Local-only entries (Rumble, phone-only) merge in by
their own timestamps. Single sort, no "local-on-top + everything else
below" split.

#### Adding a new Swift file to the native target

Use the `xcodeproj` Ruby gem
(`gem install --user-install xcodeproj`) to add the file reference
+ build phase entry in `ios-native/Vids.xcodeproj/project.pbxproj`.
Manually-created Swift files in the filesystem do not auto-add to
the Xcode target — they compile only after the pbxproj edit. Pattern:
```ruby
require 'xcodeproj'
proj = Xcodeproj::Project.open('ios-native/Vids.xcodeproj')
target = proj.targets.find { |t| t.name == 'Vids' }
group = proj.main_group.find_subpath('Vids/Player', false)
ref = group.new_reference('NewFile.swift')
target.add_file_references([ref])
proj.save
```

#### iOS native app build/install/launch

```bash
DEVICE=00008150-001241D11EF2401C
xcodebuild -project ios-native/Vids.xcodeproj -scheme Vids -configuration Debug \
  -destination "id=$DEVICE" -allowProvisioningUpdates build
APP=/Users/antonamurskiy/Library/Developer/Xcode/DerivedData/Vids-dpaerczlwtmtjjabkzienyhhksqi/Build/Products/Debug-iphoneos/Vids.app
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" com.antonamurskiy.vids
```
DerivedData path is stable per project. SourceKit reliably emits
`Cannot find type X in scope` warnings for cross-file types in this
project — those are indexer noise and don't reflect build state.
Trust `BUILD SUCCEEDED` from xcodebuild.

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

- Spawned with `--input-ipc-server=/tmp/mpv-socket` + `--keep-open` + `--ytdl-raw-options=cookies=cookies.txt` + `--autosync=30` + `--no-keepaspect-window` + `--auto-window-resize=no`
- **Window stays put across loadfile.** `--no-keepaspect-window` + `--auto-window-resize=no` prevent mpv from resizing the window when a new video has a different aspect ratio. Without these flags, switching from a 16:9 to a 21:9 (or vertical short) made the mpv window snap to the new aspect, looking like a "jump."
- **Maximize re-apply uses a multi-attempt ladder.** `aerospace fullscreen on` (idempotent — `on` doesn't toggle off if already fullscreen) fires three times after loadfile (200ms / 1.5s / 3.5s) and three times after `/api/stop-phone-stream` restores mpv visibility (100ms / 1s / 2.5s). mpv's loadfile triggers a render refresh that aerospace can latch onto AFTER our first re-apply, dropping fullscreen ~500ms-2s later (user-visible "shifted to floating"). The ladder catches every drop. Use `aerospace fullscreen on` NOT `aerospace fullscreen --no-outer-gaps on` — the gaps modifier is non-idempotent and can toggle the state off in some aerospace builds.
- **Floating mode skips the re-apply** entirely; mpv with `--no-keepaspect-window` keeps its size + position on its own.
- **`hideMpvWithRetry()` triple-fires the visibility osascript** (0/300/1200ms) anywhere we hide mpv (both `/api/watch-on-phone` paths). A single fire-and-forget sometimes silently no-op'd — System Events queue contention, mpv mid-transition, or AppleScript bridge briefly returning "process not found" — leaving the mpv window visible behind the phone player UI.
- **`/api/play` skips the live-status probe** when the frontend explicitly passes `isLive` (always does — `playVideo.js` sends `!!(video.isLive || video.live)`). Was running `yt-dlp --print live_status URL` (~3-8s) on every video click, dominating perceived latency. Now only runs when `clientIsLive === undefined && !knownVod && !isRumble`. `knownVod` = `historyMap.get(url)?.duration > 0` (already played to completion, so VOD).
- **mpv crash detection** parses yt-dlp/mpv stderr in the exit handler for known-bad failure modes (`Members-only video`, `Age-restricted`, `Region-blocked`, `Rate-limited`, etc.) and emits both an APNs `Playback failed` push and an in-app `claude-feed` toast. Was previously only pushing on signal-killed or <5s exits, missing the common "loaded for 60s then yt-dlp errored" case.
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

- **View-mode button** in NowPlayingBar: short tap cycles between sync ↔ computer (the two modes the user wants quick access to). Long-press (≥450ms) opens the full picker including phone-only. Movement >8px cancels the long-press timer.
- **Computer mode entry pauses the AVPlayer** (in addition to hiding the inline layer). Belt-and-braces against iOS auto-PiP showing STALE content — in computer mode mpv plays the new video but the AVPlayer keeps the old item loaded (warm-cache reuse), and a paused player can't auto-PiP. The warm-cache sync re-engage path explicitly calls `NativePlayer.play()` to resume.
- **Auto-PiP eligibility mirrors layer visibility.** `setLayerFrame` toggles `canStartPictureInPictureAutomaticallyFromInline` to match `wantVisible`. Skips the toggle when PiP is currently active so a live session isn't killed.
- **PiP-friendly item swap**: when a sync-mode video switch fires `NativePlayer.load()` with a new URL, the Swift side does pause → `replaceCurrentItem` → play instead of swapping the item directly. Apple's recommended sequence — replacing on a playing AVPlayer with PiP active can leave the PiP window stuck on the old item's last frame.
- Phone plays the same video as the desktop player, synced via mpv position
- **Startup latency** has been heavily tuned — the loop from "tap sync" to "in-sync with mpv" was ~12s, now ~3s warm / ~6s cold:
  - Server `/api/watch-on-phone` reads mpv state in parallel (Promise.all over `time-pos`/`file-format`/`duration`/`stream-path`); was 5 serial IPC round-trips.
  - `?warm=1` query param short-circuits the server-side yt-dlp resolve when the JS warm cache already has a valid AVPlayer item — server just flips `phoneActive=true` + hides mpv.
  - `_watchOnPhoneCache` stores `isLive=false` alongside resolved URLs so re-engages skip the ~5-8s `yt-dlp --print is_live` fallback probe.
  - PhonePlayer settle gate cut from 5s to 1.5s — the original was overkill, blocking the first drift correction.
  - First-3-seek cooldown tightened from 2.5s to 1s — initial bias-learning needs to fire close together to converge.
  - `_nativePdtMs` seeded immediately on `NativePlayer.load().then(...)` for live streams instead of waiting for the 250ms polling interval's first sample.
  - `autoStartPip()` chained after `play().then(...)` so it doesn't fall into the 6s `isPictureInPicturePossible` retry loop.
  - DASH composition track loads run parallel with duration loads via `async let` (was 2 RTTs serial).
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

#### Watch-on-phone latency mitigations (server-side)

`/api/watch-on-phone`'s yt-dlp `--get-url` resolve is the dominant cost (~3-8s cold). Three layers fight it:

1. **Disk-backed cache** at `.watch-on-phone-cache.json` (gitignored). The
   in-memory `_watchOnPhoneCache` Map persists to disk on every write,
   loaded on boot, 6h TTL. Without this, every server restart wiped the
   cache and the next sync tap paid the full yt-dlp cost again.
2. **In-flight dedupe** — `resolveWatchOnPhone(url)` keys in-progress
   resolves by URL. A play→sync sequence kicks off a prewarm on /api/play,
   then the watch-on-phone tap awaits that same promise instead of firing
   a parallel duplicate yt-dlp.
3. **Prewarm on /api/play** — for VODs, /api/play kicks off
   `prewarmWatchOnPhone(url)` in the background after `addToHistory`. By
   the time the user taps sync, the resolve is usually done.

#### Resume race in /api/watch-on-phone (read this)

`/api/play` for a VOD spawns mpv (or loadfiles into existing mpv) and
issues the resume seek inside a background IIFE — mpv's `time-pos` is
0 for ~500ms-2s after the call returns. iOS's `.onChange(of: playback.url)`
in RootView fires `phoneMode.reloadForCurrentVideo` immediately on the
WS broadcast, which calls `/api/watch-on-phone` while mpv is still at 0.
That used to make the AVPlayer load at 0 instead of the saved position.

Fix: `/api/watch-on-phone` checks `historyMap.get(url).position` and
prefers it over mpv's `time-pos` when:
```
histPos > 0 && histDur > 0
  && histPos < histDur * 0.95
  && histPos < histDur - 10
  && mpvSec < histPos - 5     // mpv hasn't seeked yet
```
The `mpvSec < histPos - 5` guard means we only override mpv when it's
clearly behind the saved position — never overrides a legitimate live
mpv position that happens to be lower than the saved one.

#### Audio device label + destination badge in NowPlayingBar

The audio button in `NowPlayingBar.swift` shows `[short device name]
[battery%] [device icon] + tiny destination badge`. Source rules:

- `phoneMode.mode == .phoneOnly` → reads from `phoneMode.phoneAudioOutput`
  / `phoneAudioPortType` (the iPhone's AVAudioSession route, refreshed on
  `AVAudioSession.routeChangeNotification`). Badge: `iphone`.
- `.computer` and `.sync` → reads from `playback.audioOutput` (the Mac's
  `SwitchAudioSource -c`). Badge: `laptopcomputer`.

Critical: **the badge MUST match whose output the label is sourced from.**
An earlier version showed `iphone` in sync mode while the label was
the Mac's AirPods name → user saw "AirPods on iPhone" when AirPods were
actually on the Mac.

Mac-side `_cachedAudioOut` requires a periodic refresh — it's only
auto-populated by the volume-button intercept's `isProtectedAudioOutput()`
gate, which only fires on actual button presses. Without a refresher
the WS broadcast sent `audioOutput: null` until the first volume press.
Fix: `refreshAudioOutCache()` runs on boot + every 5s + inline on every
`/api/audio-output` POST.

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
- **Refresh FAB**: fixed bottom-right above now-playing bar, long-press opens secret menu. Default position is `calc(var(--np-height, 220px) + 16px)` from bottom (just above the now-playing bar with the same 16px right padding). When the iOS soft keyboard opens, FABs lift to `bottom: 408px` so they don't get covered. Detected via a `body.keyboard-open` class set by `App.jsx`'s `visualViewport` listener (`window.innerHeight - vv.height > 100`). Same pattern lifts `.claude-quick-reply` from 106px → 498px.
- **Terminal: remember keyboard state on close**. The xterm helper textarea is auto-focused on terminal open IFF the iOS keyboard was up at the moment of last close. Tracked with `wasKbOpenAtCloseRef` + a `prevVisibleRef` watching the `visible` prop transition. Without this, every reopen forces the soft keyboard up even when the user dismissed it on purpose. First-ever open doesn't auto-focus (default ref state is false).
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

### Tmux window theming + scroll gating

The terminal panel ties multiple UI surfaces (terminal viewport, panel
chrome, shortcut keys, tabs strip, FAB stack, now-playing bar, iOS
safe-area gutters under the Dynamic Island and home indicator) to a
single per-window color picked via long-press → centered modal. The
color is keyed by tmux window NAME (not index) so renaming a window
to a previously-colored name picks the tint back up.

#### Color storage + sync

- `.tmux-colors.json` (gitignored): `{ [name]: "#RRGGBB" }`
- `GET /api/tmux-colors` / `POST /api/tmux-color { name, color }`
- Pushed via WS as `tmuxColors` alongside `tmuxWindows` on every focused
  `{type:"tmux"}` broadcast and the 1Hz playback tick.
- Optimistic update: `/api/tmux-select` flips `active` flags in the
  cached `tmuxWindows` array and broadcasts immediately, then kicks
  the authoritative `refreshTmuxWindows()` in the background and
  re-broadcasts on completion. The previous in-flight guard could
  swallow refreshes (auto-rename branch spawns git+tmux subprocesses)
  and leave the broadcast carrying stale active flags — UI got stuck
  on the old window.

#### Default-name auto-rename

`refreshTmuxWindows()` reads `pane_current_path` per window. When a
window's name matches a default-style pattern (`^(zsh|bash|fish|sh|tmux|node|claude)$`,
purely numeric, or equal to its cwd basename), the window is renamed
to the first 3 lowercase letters of `git rev-parse --show-toplevel`
basename and `automatic-rename off` is set so tmux doesn't fight it.
Each (index, cwd) is processed once until cwd changes — `_autoNamedTmux`
Map memoizes.

#### Color application

The picked color is the SAME hex everywhere, but applied at two
brightness tiers because a 28×28 swatch on `#151515` reads dimmer than
the same hex stretched across a tab + full-screen pane (perceptual:
Helmholtz-Kohlrausch). Both `App.jsx` and `Terminal.jsx` carry their
own `darkenHex(hex, factor=0.55)` helper that multiplies each RGB
channel — picked hex stored in JSON, darkened version painted on
every visible surface.

- **Tab background**: `darkenHex(color, 0.55)`. Active tab: keeps the
  same bg as inactive sibling and signals state with cream `--text`
  border + text (NOT brightenHex of the color — that produced bright
  yellow olive jumps that clashed with the muted swatches).
- **Terminal viewport** (xterm theme.background): `darkenHex(0.55)`.
  Re-applied via `term.options.theme = ...; term.refresh(0, rows-1)`
  whenever active window changes — WebGL atlas is keyed on theme so
  refresh forces glyph repaint with the new bg.
- **Panel chrome**: same `darkenHex(0.55)`, set inline on `.terminal-panel`
  via `--terminal-bg` CSS var. `.xterm-viewport` reads it via
  `background: var(--terminal-bg, var(--bg)) !important`.
- **Shortcut keys row**: reads `--terminal-key-bg` / `--terminal-key-bg-active`
  vars set by the panel; tinted state uses `rgba(255,255,255,0.07)` /
  `0.14` overlays so keys lift off the panel bg.
- **Body / html / iOS safe areas**: `body.style.background` + `html.style.background`
  set to `darkenHex(0.55)`, and `NativePlayer.setSafeAreaBackground(hex)`
  walks every parent UIView from the WKWebView up to UIWindow + paints
  every direct child of the window. Capacitor StatusBar inserts a
  tinted UIView at the top of the window stack that covers the
  WebView's bg — recoloring all window children catches it without
  identifying it by name. `setOverlaysWebView({overlay: true})` is
  also toggled while the terminal is open so the status bar is
  transparent and the WebView extends behind the Dynamic Island.
- **FAB stack** (`fab-cmux`, `fab-refresh`): reads `--fab-bg` /
  `--fab-bg-active` / `--fab-border` vars set on `.fab-stack` inline.
  Tinted state: raw `activeTmuxColor` (brighter than the bar bg) for
  bg, `darkenHex(0.7)` for active, `darkenHex(0.4)` for border. Off-
  theme `rgba(168,153,132,0.2)` cmux fallback was removed; claude
  waiting/thinking colors still override.
- **Now-playing bar**: subscribes to `tmuxWindows` + `tmuxColors`,
  applies `darkenHex(0.55)` as inline `background`. Scrubber track
  (`--np-track`) uses `darkenHex(0.4)`, fill (`--np-fill`) uses raw
  tint, both pattern dots use `darkenHex(0.55)`. **Only when terminal
  panel is open** — gated on `useSyncStore(s => s.terminalOpen)`.

#### Setting the iOS safe-area background

Capacitor's `@capacitor/status-bar` v8 `setBackgroundColor` is an
Android-only no-op on iOS. The custom Swift `setSafeAreaBackground`
method on `NativePlayerPlugin` is the working path — sets
`webView.backgroundColor`, `scrollView.backgroundColor`,
`webView.isOpaque = false`, then walks parents up to UIWindow AND
recolors every direct child of the UIWindow. The walk is required
because Capacitor's StatusBar plugin inserts a UIView ABOVE the
WebView in the window stack that paints with its own configured bg
and would otherwise hide the tint.

`overlaysWebView` is now PERMANENTLY `true` — set in
`capacitor.config.json` AND forced via `StatusBar.setOverlaysWebView({overlay: true})`
in `setStatusBarDark()` at app boot. Do NOT toggle this at runtime
during a tint change: the WebView frame relayout takes ~50ms and
during that window the body doesn't reach the gutter, producing
a "gutter trails body" seam. With overlay=true permanent, the body
covers the Dynamic Island gutter from boot, so its CSS `transition`
drives the gutter fade. Default WebView `backgroundColor` is
`#282828` (matches `--bg`) so any momentary peek where body briefly
doesn't cover (keyboard / safe-area relayout) matches the rest.

#### Synchronizing the tint fade across all surfaces

When the active tmux window's color changes, EVERY tinted surface
needs to fade through the same color path on the same time axis or
you get visible seams between layers. The leader was xterm — its
WebGL `theme.background` snaps when assigned, so naive theme swap
left xterm at the new color while body's CSS transition was still
mid-fade ("Dynamic Island late" perception, but actually xterm was
"too early"). The fix is to give every layer a 400ms
`cubic-bezier(0.25, 0.1, 0.25, 1)` (= CSS `ease`) transition:

- **body + html**: static CSS rule `transition: background-color 400ms cubic-bezier(0.25, 0.1, 0.25, 1)`.
  Set the rule in CSS, NOT inline in JS — setting `style.transition`
  and `style.background` in the same JS tick was sometimes batched
  into a single style-recompute that skipped the fade.
- **xterm**: drive `term.options.theme.background` via a
  `requestAnimationFrame` loop in Terminal.jsx, parsing prev + target
  hex, evaluating cubic-bezier `t` via Newton-Raphson on the x curve
  each frame, lerping channels, calling `term.refresh(0, rows-1)`.
  Tracked previous color in `xtermBgRef` so each transition starts
  from the right place.
- **Native UIView/UIWindow stack**: `UIViewPropertyAnimator(duration: 0.4)`
  with `UICubicTimingParameters(controlPoint1: (0.25, 0.1), controlPoint2: (0.25, 1.0))`
  in `setSafeAreaBackground`. Snap-only or animate-without-matching-curve
  visibly desyncs from the others.
- **`.terminal-panel`, `.xterm-viewport`, `.now-playing`,
  `.tmux-tabs button`, `.fab-*`**: same CSS transition rule. These
  all set bg via inline React `style` props, which trigger the CSS
  transition automatically when the property changes.

Things tried that DIDN'T work (don't re-litigate):
- Compensating bridge IPC latency by passing wall-clock from JS and
  fast-forwarding the native animator's `fractionComplete` — bridge
  latency is variable so any fixed compensation is wrong sometimes.
- `transition-delay` on body to wait out the bridge — same issue,
  delay needed varies per call.
- Snap everything to "give up" on the fade — works but ugly. The
  user wanted the fade.

The actual root cause was forgetting that several surfaces snapped
silently. Once every visible bg-paintable layer had the same 400ms
ease transition (or matching rAF in xterm's case), they moved as
one. **If you add a new tinted surface, give it the same
`transition: background-color 400ms cubic-bezier(0.25, 0.1, 0.25, 1)`
or it'll snap and break the illusion.**

#### CSS-var driven surfaces

Several surfaces have static `--bg` defaults that need to follow the
active tint dynamically. Instead of inline-styling every component on
every theme change, drive these via CSS variables set on
`document.documentElement`:

- `--gutter-bg` → `.safe-area-cover` (fixed div at top:0 covering
  the Dynamic Island gutter so video cards scrolling under the
  sticky header can't peek into the safe area)
- `--header-bg` → `.header` (the sticky tabs strip — was always
  `var(--bg)` gray and the tab strip stayed gray when tab tints
  were applied to body)
- `--tab-active-bg` → `.tab.active` (active tab pill highlight; set
  to a "lightened" version of the tint so it stands out against the
  tinted header)
- `--terminal-bg` → `.xterm-viewport` (already existed, panel chrome
  inline style sets it)
- `--terminal-key-bg` / `--terminal-key-bg-active` → shortcut keys
- `--np-fill` / `--np-fill-pattern` / `--np-track` /
  `--np-track-pattern` → now-playing scrubber bar
- `--fab-bg` / `--fab-bg-active` / `--fab-border` → FAB buttons

Keeping these as CSS vars (with the same 400ms ease transition rule
on the consuming selector) means tint changes happen via a single
`html.style.setProperty('--var', value)` call instead of forcing
React re-renders on every component.

#### Live preview during the rename modal

Tapping a swatch should immediately repaint the entire UI in that
color (terminal, body, gutter, tabs, FAB, now-playing) without the
user committing first. Naively writing the optimistic value to
`tmuxColors` doesn't work — the server's 1Hz WS broadcast keeps
overwriting it with persisted state, snapping the preview back to
the original color mid-cycle.

Fix: a separate `tmuxColorPreview: { [name]: hex }` map in the
playback store that the server NEVER touches. Consumers
(TmuxTabButton, App's `resolveColor`, Terminal's `activeColor`,
NowPlayingBar's `tmuxTint`) check `tmuxColorPreview[name]` first
and fall back to `tmuxColors[name]`. Modal commit/cancel clears
the entry; once the server's broadcast lands the new color via
`tmuxColors`, the preview override is gone and the resolved color
is identical.

The modal overlay is `background: transparent; pointer-events: none`
with `pointer-events: auto` on the card so the live preview stays
visible behind the popover while the user cycles colors.

#### Per-tab tinting

A `TAB_TINTS` map in App.jsx mirrors the same darken pipeline tmux
windows use. Currently:
- `history` → `#1f3d24` (forest green)
- `live` → `#a13a36` (red+)
- `ru` → `#4f8a5c` (green+)

When `terminalOpen` is false, the active tab's tint paints body,
html, the gutter cover, the header bg, the active-tab pill (via
the lighten-by-15% derivation), and the native safe-area. When
terminal opens, that effect early-returns and Terminal's effect
takes over; on close, Terminal's cleanup restores body bg to what
the tab effect last set.

Critical: the per-tab tint effect has **NO cleanup function**. An
earlier version with cleanup raced Terminal's effect on the
open transition — App's cleanup restored body to the pre-history
gray AFTER Terminal had already painted its tint, leaving the
terminal pane gray. Now the App effect just sets bg idempotently
based on `(terminalOpen, activeTabTint)`; on transitions, Terminal's
effect captures the latest body bg as `prevBody` and restores it
correctly on close. NowPlayingBar reads its own copy of TAB_TINTS
+ `activeTab` from `useUIStore` and falls through to the tab tint
when terminal is closed, so the bar (including scrubber) follows
the active tab too.

#### Native plugin animator excludes the player view

`setSafeAreaBackground`'s parent walk + window-children loop animates
`backgroundColor` on every UIView from the WebView up to UIWindow.
`playerContainer` is added as a SIBLING of the WebView (under
`wv.superview`), so the loop was hitting both `playerContainer` AND
its host (`wv.superview`). Animating either drives compositing on
the same UIView that hosts the AVPlayerLayer, which competes with
video decode AND the live-sync drift loop's
`AVPlayerItem.currentDate()` sampling. PiP visibly skipped, drift
never converged. Fix: skip both `playerContainer` and `playerHost`
from the animation. WebView itself still animates so the body fade
still has its colored backdrop.

#### Source-map of "the gutter is gray / late"

Whenever the Dynamic Island gutter looks wrong, walk this list:

- **Gray when terminal is closed but on a tab with a TAB_TINTS entry**:
  `--gutter-bg` not being set. Verify the per-tab tint effect ran
  (look for `terminalOpen=false`).
- **Gray inside terminal**: Terminal's tint effect didn't fire — check
  `activeColor` resolution (preview override + tmuxColors fallback).
  Or its bg got overwritten by App's per-tab effect cleanup (which
  shouldn't exist anymore — see "Per-tab tinting" above).
- **Late by a fixed delay (~50ms)**: bridge IPC. Don't try to
  compensate with `transition-delay` or `fractionComplete`
  fast-forward — both fail because bridge latency is variable. The
  fix is overlay-mode (overlaysWebView=true permanent) so body
  covers the gutter and its CSS transition drives the visible fade
  directly.
- **Snaps while body fades**: a surface that needs `transition:
  background-color 400ms cubic-bezier(0.25, 0.1, 0.25, 1)` doesn't
  have one. Audit every visible-bg surface (header, panel, FAB, NP
  bar, tabs, scrubber, gutter cover, etc).
- **xterm-specific snap**: xterm's `theme.background` doesn't
  animate. Drive it through the `requestAnimationFrame`
  interpolator in Terminal.jsx (Newton-Raphson on the cubic-bezier
  for matching curve).

#### Rename popover (centered portal modal)

Long-press any tmux tab → `createPortal(modalNode, document.body)`
renders a centered `.tmux-edit-overlay` with the rename input + 8
muted swatches + `cancel` / `ok` buttons. Why portal: an inline
edit row inside the position:fixed `.tmux-tabs` strip vanished when
the iOS soft keyboard opened (visualViewport reflow clipped the strip
off-screen). Centered modal is immune.

There is NO outside-tap dismissal — iOS focus()→keyboard-open
synthesizes pointer events outside the popover that were closing it.
User dismisses explicitly via Enter / Escape / ok / cancel.

#### Pane-swipe scroll suppression — READ THIS

xterm's WebGL renderer + tmux mouse-mode + iOS touch all conspire to
make swiping between tmux windows easy to mis-aim into a vertical
"scroll up" that lands the user in tmux's copy-mode buffer 50 lines
back. Multiple defenses stacked because each only solves part:

1. **Pin loop**: persistent `setInterval(20ms)` that calls
   `term.scrollToBottom()` whenever `Date.now() < scrollLockUntilRef`.
   Set to `now+1200ms` on every active-window change. Bails when
   `scrollZoneRef.current` is truthy (user is explicitly scrolling).
2. **Horizontal touchmove extends lock**: any touchmove with
   `dx > 30 && dx > dy*1.2` extends `scrollLockUntilRef` by another
   1000ms so a slow cross-screen swipe stays pinned.
3. **`pointer-events: none !important` on `.xterm` subtree**: the
   ACTUAL cause of "I can scroll anywhere" was tmux mouse-mode —
   xterm forwards touch-drag events as SGR mouse escape sequences
   to the pty, and tmux scrolls its own copy-mode buffer in
   response. CSS-only scroll fixes can't help because the scroll
   lives in the pty, not the DOM. With pointer-events: none on
   `.xterm`, touches never reach xterm's mouse reporter, nothing
   forwards to tmux. Touches pass through to `terminal-container`
   for swipe detection. `refocusOnTap` still focuses the
   `.xterm-helper-textarea` because `.focus()` is programmatic
   (bypasses pointer-events). Typing works because keyboard events
   target the focused textarea, not via touch. Lost: native long-
   press text selection on mobile (acceptable). Re-applied via
   `MutationObserver` since xterm rebuilds internal nodes on
   resize/theme change.
4. **`touch-action: none !important` + `overflow: hidden !important`**
   on `.xterm-viewport` (also via `setProperty('important')`) belt-
   and-braces in case the browser ever generates a scroll event.
5. **Right-edge `.terminal-scroll-zone`** (64px, `z-index:2`): the
   ONLY way to scroll. Aligned with the FAB column visually so the
   affordance is memorable. On touchmove computes `lines = -dy / rowH`
   and:
   - Sends SGR mouse-wheel sequences over the WebSocket so tmux
     scrolls its copy-mode buffer:
     - Up: `\x1b[<64;X;YM`
     - Down: `\x1b[<65;X;YM`
   - Falls through to `term.scrollLines(lines)` for non-mouse-mode
     panes (Claude prompts etc).
   Wheel-event count capped at 8 per touchmove tick.
6. **`scrollToBottom()` on every active window change** (1.2s pin)
   so even if a touch slips through, the buffer snaps back.
7. **`refocusOnTap` skip for swipe gestures**: tracks tap start coords
   in a paired native touchstart listener (capture phase wasn't
   needed once pointer-events: none was added). Bails on `dx > 12`
   / `dy > 12` / `dt > 500ms` so swipes between panes don't pop the
   iOS keyboard via auto-focus on the helper-textarea.

#### Feed swipe navigation

Horizontal swipe on the body wrapper (`ptrBodyRef`) cycles between
`['rec', 'history', 'subs', 'ru', 'live']`. Same heuristic as the
tmux pane swipe: `dx > 80 && dx > dy*1.5 && dt < 500ms`. Channel /
search / filtered "side" tabs are skipped — they aren't part of
the carousel.

A native non-passive `touchmove` listener locks direction at
`dx ≥ 16`. Locked-horizontal touches `preventDefault()` for the
rest of the gesture so the page can't scroll vertically while
swiping. React's synthetic `onTouchMove` is passive — `preventDefault`
there is a no-op, hence the native listener.

#### Terminal keys safety

The `.terminal-keys` row uses event delegation: the parent's
`onTouchEnd` fires `e.target.closest('button').click()` on tap. iOS
pops the keyboard on xterm focus taps, layout shifts, and a
synthetic `touchend` was landing on a key (most often ^Z, since
it sat in the middle of the row) → Claude got suspended out from
under the user.

Two-stage fix:
1. **`touchStartButtonRef`** latches the button under the finger at
   `touchstart`. `touchend` requires `closest('button')` to return
   the SAME element. Touches that begin on xterm and end on a key
   no-op.
2. **`data-require-hold="1"`** on ^Z and ^D buttons. Even if start
   and end button match, the parent handler reads the data attribute
   and gates on `Date.now() - touchStartTRef.current >= 400`.
   Accidental taps no-op; deliberate hold fires.

#### Tap-vs-scroll on xterm

When the user taps to focus the helper-textarea (bring up keyboard),
`refocusOnTap` reads `tapStartRef` to skip swipe gestures (`dx > 12`
/ `dy > 12` / `dt > 500`) so the keyboard doesn't pop on every
pane swipe.

`pointer-events: none !important` is set on `.xterm-screen` and
`.xterm-viewport` (NOT the `.xterm` root — that auto-dismissed the
keyboard on every active-window switch by treating the focused
helper-textarea as ancestor-of-non-interactive).

Right-edge `.terminal-scroll-zone` (64px overlay) is the ONLY way
to scroll. Touchmove sends SGR mouse-wheel sequences over the WS
to drive tmux's copy-mode scroll (`\x1b[<64;X;YM` up,
`\x1b[<65;X;YM` down). On `touchend` / `touchcancel`, fires
`POST /api/tmux-cancel-copy-mode` (which runs `tmux send-keys -X cancel`)
so the user doesn't get stuck in copy-mode after every scroll
gesture (would otherwise need to manually press `q` to type again).

### Audio output menu (NowPlayingBar)

Tapping the audio output icon in the NowPlayingBar opens a popover
with two collapsible submenus — both default open:

- **Output** (collapsible header with `AudioOutputIcon` + chevron):
  the macOS audio output devices. Active device gets
  `color: var(--green)`, `background: rgba(126,142,80,0.18)`, and
  a `3px solid var(--green)` left stripe. Indented `paddingLeft: 24`.
- **Bluetooth** (same header pattern): system BT devices.
  **Connected** items get blue treatment instead of green — `var(--blue)`
  text, `rgba(108,153,187,0.18)` overlay, `3px solid var(--blue)`
  left stripe. Distinct from green-active output rows so you can
  tell at a glance which is "currently routing audio" (green) vs
  "connected but not active" (blue).

Same active-color treatment in SecretMenu's audio outputs (defaults
open) and BT items.

### Secret-menu submenu styling

`.secret-menu-item.sub` adds a darker `#0a0a0a` bg (vs the menu's
`#151515`) so nested submenu rows are visually distinct from the
top-level menu. Applied to: audio-output picker rows, Bluetooth device
rows, Misc submenu (Brightness, FontSize, Font, Grid toggle, Refresh
cookies, AirPlay, Focus cmux, Font sub-options at +1 nesting level),
and the FindMy friend info row. `GridStyleToggle` takes a `sub` prop;
others hardcode the class.

### Find My friend lookup — `/api/findmy-friend`

Maria's location pulled from the FindMy macOS app via screenshot →
OCR → pin detection → cross-street resolution. Deterministic, no AI.
~1.5–3s end-to-end depending on FM refresh path.

#### Pipeline

1. **Screenshot.** `screencapture -l <CGWindowID>` if stealth mode is
   on (FM parked off-screen on workspace 1, captured by window-id);
   else `-D 2` for laptop display 2. Saves to
   `/tmp/ytctl-findmy.png`.
2. **OCR.** `bin/findmy-ocr` (compiled from `scripts/ocr.swift` on
   boot) runs Apple Vision `VNRecognizeTextRequest` and prints one
   row per detected text:
   `x,y,w,h,angleDeg\ttext`
   `angleDeg` is the **text baseline angle** in degrees — read
   from Vision's rotated quadrangle (`bottomLeft → bottomRight`
   vector). Apple Maps places street labels along the road, so
   the baseline IS the road's direction at that label point. This
   one number is what cracked the cross-street problem; **don't
   replace it with bbox-aspect inference or single-grid-angle
   detection** — those were tried and were strictly worse.

   `req.minimumTextHeight = 0.005` (low). Default ~0.03125 dropped
   PALMETTO ST and other smaller labels at wider display
   resolutions, so the geometric ranker had no Palmetto candidate
   and returned a wrong answer. Don't bump this back up unless
   you're seeing clear false positives from tiny artifacts.
3. **Friend row match.** `rows.filter(r => text.includes(name))`
   — name is e.g. `"mchimishkyan"` (from `useMariaProximity.js`),
   matches the email/contact label in FM's People panel.
4. **Pin detection.** `bin/findmy-pin` (from
   `scripts/find-pin.swift`) finds the white person-silhouette
   pin in the map area. Algorithm: connected-component white
   pixels (RGB ≥ 240) of size 50–800, compact aspect, surrounded
   by uniform mid-grey ring (the pin body). Outputs
   `cx,cy,bw,bh` — silhouette centroid + actual bbox dims so
   the pin location scales correctly across HiDPI / Retina /
   non-Retina displays.
5. **OCR fragmentation reconstruction**
   (`reconstructFragmentedStreetLabels`). Vision splits rotated
   compound names: `"FRESH POND RD"` comes out as `["FRESH"]` +
   `["I POND RD"]` (F→I misread) and the surrounding `FreshPond
   Hardware` business label. When a regex-rejected fragment
   (first word ≤ 2 chars) sits within ~200px of a known prefix
   hint (`FRESH`, `OLD`, `NEW`, `WEST`, etc.), synthesize a
   corrected row at the union bbox. Special-cased: prefix=FRESH
   + suffix=RD + nearby `POND` → emit `FRESH POND RD` (avoids
   the lossy `FRESH RD`).
6. **Cross-street resolution** (`nearestCrossStreet`). Two
   metrics, picked by family:
   - **Parallel family** (`bbox aspect > 1.6`, residential
     streets running mostly along the local grid): perpendicular
     distance from pin to the LINE through the label center at
     the label's baseline angle. `dist = |v × dir|` where
     `dir = (cos θ, sin θ)`, `v = (cx − lcx, cy − lcy)`.
     Closest = STREET-ON-PIN.
   - **Cross family** (`aspect ≤ 1.6`, perpendicular avenues):
     Euclidean distance to label center. Naturally penalizes
     streets across the map (Admiral Ave at the top of the view
     when the pin is at the bottom).
   Closest of each family → `"Parallel St & Cross Ave"`.

#### Why these specific choices

- **Per-label baseline angle, not single grid angle.** NYC
  Queens grid has streets at varying angles (Madison runs at
  −18°, Palmetto more horizontal). Inferring a single grid angle
  from same-name pairs gave wrong answers on streets with
  different angles. Vision's quadrangle gives each label its
  own angle directly.
- **No road-walk BFS.** A `scripts/road-walk.swift` exists from
  earlier iteration that does pixel-level BFS along a road-color
  mask with barrier detection (train tracks, water). It works in
  principle but the road mask fragments at intersections — every
  tuning of color tolerance, dilation, V-band threshold gave
  worse net results than the simple geometric heuristic. Kept in
  the repo as a reference implementation; **not called from the
  hot path**.
- **No vision LLM.** Tried qwen2.5vl:7b, qwen3-vl:8b (thinking
  + instruct), qwen3-vl:4b-instruct via Ollama. All gave
  inconsistent answers, took 5–90s per call, and underperformed
  the deterministic algorithm. Ollama uninstalled, models deleted.
  Don't re-add without external ground truth (e.g. lat/long
  from a Find My private API) to validate against.
- **Pin tail offset is 0.** Earlier code added `1.4 × bbox.h` to
  the silhouette centroid to land on the pin "tip." Modern Apple
  Maps friend pins are tail-less circles — the centroid IS the
  map location. Don't add an offset.

#### Stealth mode + force-refresh

`/api/refresh-findmy` activates FM via `osascript`, waits **3s**
for FM to actually pull fresh location data from iCloud, then
re-parks the window via `parkFindMyStealth` (workspace 1, sized
1470×923, positioned off-screen sliver at 2557,1322). 300ms
wasn't enough — re-park happened before the network refresh
completed, leaving timeFragment stuck. The endpoint AWAITS the
full cycle so the frontend's follow-up `/api/findmy-friend?force=1`
hits a re-parked + refreshed window. Don't put `setTimeout` back.

#### Resolution / HiDPI

All pixel-distance constants in `road-walk.swift` derive a
`SCALE = W / 2940` from screenshot width and apply it to dilation
radius, BFS depth cap, label window, spiral search radius. Server
uses the actual `pinLabel.h` from find-pin (not a hardcoded 40px)
for any size-dependent math. Switching displays adjusts
automatically because the screenshot's pixel dimensions encode
the rendered scale.

#### Pre-compiled binaries

Compiled on server boot if source mtime is newer than binary mtime:
- `bin/findmy-ocr` ← `scripts/ocr.swift`
- `bin/findmy-pin` ← `scripts/find-pin.swift`
- `bin/findmy-road-walk` ← `scripts/road-walk.swift` (dormant)

Each binary is fast-launch (~50ms). `swift <src>` JIT-compiles per
invocation (~5–10s) and can wedge System Events under load — there's
a recovery story in commit history (`killall "System Events"`).

#### Debug

- `ROADWALK_DEBUG=1` — per-label distance dump on stderr
- `ROADWALK_DEBUG_MASK=path` — dump road-color mask as PNG
- `ROADWALK_DEBUG_VISITED=path` — dump BFS visited set as PNG (green = reached, grey = road but unreachable)

## Key Files

- `.env` — `YOUTUBE_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `.tokens.json` — OAuth tokens (runtime, gitignored)
- `.history.json` — Watch history with position/duration (runtime, gitignored)
- `cookies.txt` — Firefox YouTube cookies, exported on startup (runtime, gitignored)
- `/tmp/mpv-socket` — mpv IPC socket (runtime)
- `activePlayer` — server-side variable: `'mpv'` | `null`
- `currentLiveHlsUrl` — upstream YouTube HLS URL for the live stream currently playing (read by streamlink via `/api/hls-live.m3u8` and by PDT tracking)
- `bin/brightness` — Swift binary compiled on server boot from `bin/brightness.swift`, drives the active display's brightness for the Misc-submenu slider
- `bin/findmy-ocr`, `bin/findmy-pin`, `bin/findmy-road-walk` — Swift binaries compiled on server boot from `scripts/*.swift`. Hot path uses ocr + pin; road-walk is dormant. See "Find My friend lookup".
- `/tmp/ytctl-findmy.png` — most recent FindMy screenshot, source of truth for OCR + pin detection
- `.findmy-stealth.json` — `{ on: bool }` stealth-mode persistence
- `public/silent.m4a` — truly silent 5-minute m4a for iOS Media Session (must be actual silence, not low volume — iOS drops session at volume=0)
