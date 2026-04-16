# YouTubeCtrl iOS

Native iOS shell for YouTubeCtrl. Loads `yuzu.local:3000` in a WKWebView and
exposes an `AVPlayer`-based plugin so phone mode gets real Picture-in-Picture,
lock-screen controls, and background audio.

## How it works

- Capacitor app configured (via `capacitor.config.json`) to load
  `http://yuzu.local:3000` as its content URL. As long as your Mac is running
  `npm start`, any code change on the server is instantly reflected in the app
  — no rebuild/redeploy cycle.
- A custom Swift plugin (`NativePlayerPlugin.swift`) wraps `AVPlayer` +
  `AVPictureInPictureController`. When the web UI detects it's running natively
  (via `window.Capacitor`), it routes phone playback through the native plugin.

## Build + install on your phone (free, 7-day cert)

1. Install Xcode (from the Mac App Store) if you don't have it.
2. Open the project:
   ```sh
   cd ios-app
   npx cap open ios
   ```
3. In Xcode:
   - Select the `App` target.
   - **Signing & Capabilities** → set **Team** to your Personal Team (tap "Add
     Account…" and sign in with your Apple ID if needed).
   - Change the **Bundle Identifier** if `com.antonamurskiy.youtubectrl` is
     taken — something like `com.<yourname>.youtubectrl` works.
   - Plug in your iPhone, select it as the run destination, hit ⌘R.
   - First launch: go to Settings → General → VPN & Device Management → trust
     the developer profile.
   - First run only: iOS will ask to let the app find devices on the local
     network — allow it.

The certificate expires after 7 days; re-run from Xcode to refresh.

## When you change things

- **Server or frontend only**: nothing to do. The app loads the live server on
  launch. Just `npm run build` in `client/` as usual.
- **Native code (Swift)**: rebuild in Xcode (⌘R).
- **Capacitor config changes**: `npx cap sync` in `ios-app/`.

## Troubleshooting

- **App shows a blank white screen**: the Mac isn't running the server, or
  `yuzu.local` doesn't resolve on your phone's network. Test by opening
  `http://yuzu.local:3000` in mobile Safari first.
- **No PiP button**: make sure you're using the app built from Xcode, not the
  PWA installed to home screen. PiP only works through the native plugin.
- **Audio stops in background**: the audio session category is set to
  `.playback` in `AppDelegate.swift`. If you backgrounded the app without
  starting playback, iOS might have suspended it — tap play in the native
  controls first.
