import Foundation
import Observation

struct FeedLine: Identifiable, Hashable {
    let id = UUID()
    let text: String
    let at: Date
}

@Observable
final class PushStore {
    private(set) var feed: [FeedLine] = []
    var apnsToken: String? = nil
    private var pruneTimer: Timer?
    /// Lifetime in seconds. Matches the React app's pruneClaudeFeed cutoff.
    let lifetime: TimeInterval = 30

    init() {
        // Prune every second so lines fade off without piling up forever.
        pruneTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.prune()
        }
    }

    func appendFeed(_ lines: [String]) {
        let now = Date()
        feed.append(contentsOf: lines.map { FeedLine(text: $0, at: now) })
        if feed.count > 200 { feed.removeFirst(feed.count - 200) }
    }

    private func prune() {
        let cutoff = Date().addingTimeInterval(-lifetime)
        feed.removeAll { $0.at < cutoff }
    }
}
