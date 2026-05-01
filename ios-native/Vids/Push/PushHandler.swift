import UIKit
import UserNotifications

/// Phase 8 stub. Just enough to keep AppDelegate compiling and
/// register the action-button categories that the server expects.
final class PushHandler: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushHandler()
    private(set) var token: String? = nil

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
        // Phase 8: POST to /api/apns-register with hex.
    }

    func didFailToRegister(error: Error) { /* phase 8 */ }

    // Foreground presentation: don't double-up with in-app feed/quick-reply
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        // Phase 8: parse ANSWER_N → call /api/tmux-select + /api/tmux-send.
        completionHandler()
    }
}
