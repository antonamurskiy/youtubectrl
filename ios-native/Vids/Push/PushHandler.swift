import UIKit
import UserNotifications

/// Push handler. Foreground presentation suppressed (in-app feed handles
/// it). Action buttons (CLAUDE_PROMPT_2/3/4 + ANSWER_N) parse the
/// digit + tmux window from the notification payload, drive
/// `/api/tmux-select` + `/api/tmux-send` so the answer lands in
/// Claude's prompt without bringing the app to the front.
///
/// CLAUDE.md > "APNs push" describes the foreground-only delivery
/// invariant (silent / background-session both fail). 5s key-based
/// dedupe between `getPendingPushTap` cold-launch drain and live
/// pushTap event still applies.
final class PushHandler: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushHandler()
    private(set) var token: String? = nil
    weak var services: ServiceContainer?

    private var recentTaps: [String: Date] = [:]

    func registerCategories() {
        let actions2 = [
            UNNotificationAction(identifier: "ANSWER_1", title: "1", options: [.foreground]),
            UNNotificationAction(identifier: "ANSWER_2", title: "2", options: [.foreground]),
        ]
        let actions3 = actions2 + [UNNotificationAction(identifier: "ANSWER_3", title: "3", options: [.foreground])]
        let actions4 = actions3 + [UNNotificationAction(identifier: "ANSWER_4", title: "4", options: [.foreground])]
        let cats: [UNNotificationCategory] = [
            UNNotificationCategory(identifier: "CLAUDE_PROMPT_2", actions: actions2, intentIdentifiers: []),
            UNNotificationCategory(identifier: "CLAUDE_PROMPT_3", actions: actions3, intentIdentifiers: []),
            UNNotificationCategory(identifier: "CLAUDE_PROMPT_4", actions: actions4, intentIdentifiers: []),
        ]
        UNUserNotificationCenter.current().setNotificationCategories(Set(cats))
    }

    func didRegister(token data: Data) {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        token = hex
        Task {
            do { try await services?.api.registerAPNS(token: hex) }
            catch { print("[push] register failed: \(error)") }
        }
    }

    func didFailToRegister(error: Error) {
        print("[push] failed to register: \(error)")
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Foreground: skip banner so in-app feed isn't double-counted.
        completionHandler([])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        let id = response.actionIdentifier
        guard id.hasPrefix("ANSWER_"), let n = Int(id.dropFirst("ANSWER_".count)) else { return }
        let userInfo = response.notification.request.content.userInfo
        let window = userInfo["tmuxWindow"] as? String
        let windowIndex = userInfo["tmuxIndex"] as? Int
        let key = "\(window ?? "?"):\(n)"
        let now = Date()
        if let prev = recentTaps[key], now.timeIntervalSince(prev) < 5 { return }
        recentTaps[key] = now
        Task { [weak self] in
            guard let self, let api = self.services?.api else { return }
            // Select the right tmux window FIRST so the digit lands in
            // the pane that asked the question. Without this, /api/tmux-send
            // hits whatever window is currently active.
            let windows = self.services?.terminal.windows ?? []
            if let idx = windowIndex {
                try? await api.tmuxSelect(index: idx)
            } else if let name = window,
                      let target = windows.first(where: { $0.name == name }) {
                try? await api.tmuxSelect(index: target.index)
            }
            // Tiny pause so tmux's window-switch lands before we send.
            try? await Task.sleep(nanoseconds: 80_000_000)
            try? await api.tmuxSend(String(n))
        }
    }
}
