import UIKit
import AVFoundation
import UserNotifications
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate, URLSessionDelegate, URLSessionTaskDelegate {

    var window: UIWindow?
    // Background URLSession for action-button silent dispatch. The
    // system's BackgroundTransferService runs uploads out-of-process
    // and re-launches the app briefly when transfers complete.
    // Identifier MUST be stable across launches so iOS can hand
    // pending tasks back to the right session.
    private lazy var bgSession: URLSession = {
        let cfg = URLSessionConfiguration.background(withIdentifier: "com.antonamurskiy.ytctl1289.answer")
        cfg.sessionSendsLaunchEvents = true
        cfg.isDiscretionary = false
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()
    var bgSessionCompletionHandler: (() -> Void)?
    // Pending tmux window index from a notification tap that arrived
    // before the WebView's WS bridge was ready. JS reads + clears
    // these on its next foreground poll via getPendingPushTap.
    static var pendingTmuxFocusIndex: Int? = nil
    static var pendingAnswer: String? = nil
    static var pendingDebugAction: String? = nil

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Force-reference the NativePlayerPlugin class so the linker keeps it.
        // Capacitor discovers plugins via Objective-C runtime metadata; without
        // a direct reference, the linker dead-strips the class from the binary.
        _ = NativePlayerPlugin.self

        // Configure audio session for background playback + Picture-in-Picture.
        // Without this, iOS would pause video when backgrounded and disable PiP.
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playback,
                mode: .moviePlayback,
                options: [.allowAirPlay]
            )
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("Audio session setup failed: \(error)")
        }
        // UNUserNotificationCenterDelegate must be set BEFORE the app
        // finishes launching for action-button taps to be delivered.
        UNUserNotificationCenter.current().delegate = self
        registerNotificationCategories()
        // Cancel any background URLSession uploads left over from a
        // previous build (we used to dispatch action-button POSTs
        // via the bg session; iOS persists those across launches
        // and would re-send them on next foreground, double-firing).
        let staleSession = URLSession(
            configuration: .background(withIdentifier: "com.antonamurskiy.ytctl1289.answer"),
            delegate: nil,
            delegateQueue: nil
        )
        staleSession.invalidateAndCancel()
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            if granted {
                DispatchQueue.main.async {
                    application.registerForRemoteNotifications()
                }
            }
        }
        return true
    }

    // Build CLAUDE_PROMPT_2/3/4 categories with N inline action buttons
    // labeled "1", "2", "3", "4". Identifier on the action carries the
    // digit so didReceive can read it back without parsing.
    private func registerNotificationCategories() {
        var cats: Set<UNNotificationCategory> = []
        for n in 2...4 {
            var actions: [UNNotificationAction] = []
            for i in 1...n {
                actions.append(UNNotificationAction(
                    identifier: "ANSWER_\(i)",
                    title: "\(i)",
                    // .foreground: launches the app to process the
                    // tap. Tried two silent-dispatch routes (no
                    // .foreground): URLSession.shared was killed
                    // before reaching the local server; bg
                    // URLSession worked but iOS retried the upload
                    // when the app foregrounded, double-sending the
                    // digit. .foreground gives a reliable single
                    // delivery path through the live JS fetch at
                    // the cost of bringing the app forward.
                    options: [.foreground]
                ))
            }
            cats.insert(UNNotificationCategory(
                identifier: "CLAUDE_PROMPT_\(n)",
                actions: actions,
                intentIdentifiers: [],
                options: []
            ))
        }
        UNUserNotificationCenter.current().setNotificationCategories(cats)
    }

    // Foreground delivery — show the banner even while the app is in
    // front, otherwise notifications silently route to history.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    // Tap or action-button selection. Two flows:
    //   - ANSWER_N: POST to /api/tmux-send so the digit lands in the
    //     active Claude prompt (the server ensures the active tmux
    //     window matches the one the push came from).
    //   - default tap: stash the source tmux window so the JS side
    //     can focus that pane on next foreground poll.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        let tmuxIdx = userInfo["tmuxWindow"] as? Int ?? -1
        var answer = ""
        if action.hasPrefix("ANSWER_"), let digit = action.dropFirst("ANSWER_".count).first {
            answer = String(digit)
        }
        AppDelegate.pendingTmuxFocusIndex = tmuxIdx >= 0 ? tmuxIdx : nil
        AppDelegate.pendingAnswer = answer.isEmpty ? nil : answer
        AppDelegate.pendingDebugAction = "action=\(action) tmuxIdx=\(tmuxIdx) keys=\(userInfo.keys.map { String(describing: $0) }.joined(separator: ","))"
        NotificationCenter.default.post(
            name: Notification.Name("YTCtrlPushTap"),
            object: nil,
            userInfo: ["tmuxWindow": tmuxIdx, "answer": answer]
        )
        // No bgPost — JS handles the fetch via live window.fetch
        // when the app foregrounds. Background URLSession was
        // retrying uploads on app foreground, double-sending the
        // digit; .foreground action launches the app for a single
        // reliable delivery path.
        completionHandler()
    }

    // Helper: POST a JSON body via the shared background URLSession.
    // Body is written to a temp file because background uploadTasks
    // require a file URL — they don't accept Data directly.
    private func bgPost(path: String, body: [String: Any]) {
        guard let url = URL(string: "http://yuzu.local:3000\(path)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("apns-\(UUID().uuidString).json")
        do {
            try data.write(to: tmp)
        } catch {
            print("bgPost write failed: \(error)")
            return
        }
        bgSession.uploadTask(with: req, fromFile: tmp).resume()
    }

    // Required for background URLSessions: iOS hands the event back
    // here when the app is launched in background to deliver
    // completion. Stash the completion handler so URLSessionDelegate
    // callbacks can invoke it once all tasks finish.
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        if identifier == "com.antonamurskiy.ytctl1289.answer" {
            bgSessionCompletionHandler = completionHandler
        } else {
            completionHandler()
        }
    }

    // URLSessionDelegate: all queued background tasks have finished
    // for the named session. Fire any stashed completion handler so
    // iOS can suspend the app.
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            let h = self.bgSessionCompletionHandler
            self.bgSessionCompletionHandler = nil
            h?()
        }
    }

    // APNs handed us a device token. Hex-encode and POST to the server
    // so the kill-feed pusher knows where to send notifications.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("APNs token: \(hex)")
        guard let url = URL(string: "http://yuzu.local:3000/api/apns-register") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["token": hex])
        URLSession.shared.dataTask(with: req).resume()
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("APNs registration failed: \(error)")
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Capacitor plugins (notably @capacitor/local-notifications)
        // claim the UNUserNotificationCenter delegate slot on load
        // AND replace our notification categories with their own.
        // Reclaim both here — didBecomeActive runs after all plugins
        // initialize, so we win the race.
        UNUserNotificationCenter.current().delegate = self
        registerNotificationCategories()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Handle youtubectrl://play?url=<YouTube URL> from share sheet / Shortcuts.
        // Forwards the URL to the server's /api/play endpoint so desktop mpv picks it up.
        if url.scheme == "youtubectrl" {
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            if url.host == "play",
               let ytUrl = components?.queryItems?.first(where: { $0.name == "url" })?.value {
                forwardPlay(ytUrl: ytUrl)
                return true
            }
        }
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    private func forwardPlay(ytUrl: String) {
        guard let serverUrl = URL(string: "http://yuzu.local:3000/api/play") else { return }
        var req = URLRequest(url: serverUrl)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["url": ytUrl]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req).resume()
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
