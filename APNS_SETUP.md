# APNs activation checklist

Wired up but disabled until paid Apple Developer Program activates.
Free Personal Teams can't sign apps with the Push Notifications
capability, so the entitlement reference is currently OFF in the
Xcode project.

## After your paid dev account is active

### 1. Create the APNs auth key
- developer.apple.com → Certificates, IDs & Profiles → **Keys** → **+**
- Name: anything (e.g. "YouTubeCtrl APNs")
- Check **Apple Push Notifications service (APNs)**
- Continue → Register → **Download** the `.p8` file (you only get to download once)
- Note the **Key ID** (10-char string shown next to the key)
- Note the **Team ID** (top-right of the developer page, 10-char alphanumeric)

### 2. Drop the .p8 somewhere the server can read
```bash
mv ~/Downloads/AuthKey_XXXXXXXXXX.p8 /Users/antonamurskiy/dev/youtubectrl/.apns-key.p8
chmod 600 /Users/antonamurskiy/dev/youtubectrl/.apns-key.p8
```
The path is gitignored as `.apns-key.p8` — it should be added to
`.gitignore` if not already (the auth key is sensitive).

### 3. Fill in `.env`
```
APNS_KEY_PATH=/Users/antonamurskiy/dev/youtubectrl/.apns-key.p8
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=86UQNMF8QF
APNS_TOPIC=com.antonamurskiy.ytctl1289
APNS_PRODUCTION=false
```

### 4. Re-enable the entitlement in the Xcode project
Add `CODE_SIGN_ENTITLEMENTS = App/App.entitlements;` back to both
the Debug and Release `buildSettings` blocks for the `App` target
in `ios-app/ios/App/App.xcodeproj/project.pbxproj`. The
`App.entitlements` file already exists with `aps-environment =
development`.

### 5. Rebuild + install
```bash
cd ios-app/ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -destination "id=$DEVICE" -allowProvisioningUpdates build
xcrun devicectl device install app --device "$DEVICE" "$APP_PATH"
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE"
```

### 6. Verify
- On first launch, iOS prompts for notification permission
- Server log should show `APNs: registered token (xxxx…)` once
  `AppDelegate.didRegisterForRemoteNotificationsWithDeviceToken` posts
  to `/api/apns-register`
- Server log should show `APNs: provider ready (production=false)`
  if the `.p8` and IDs are valid
- Background the app, trigger a Bash from Claude — push lands within
  ~1s regardless of WebView suspension state

### Notes
- `APNS_PRODUCTION=false` matches `aps-environment = development` in
  the entitlement. When you ship to TestFlight/App Store, change the
  entitlement to `production` and flip the env var.
- `collapseId = "claude-feed"` collapses repeated kill-feed pushes to
  one banner. Removing that key gets a stack of banners instead.
- `.apns-tokens.json` (gitignored) persists the device tokens across
  server restarts. APNs failures with reason `BadDeviceToken` /
  `Unregistered` auto-purge the token.
