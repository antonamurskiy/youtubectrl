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
    /// Lifetime in seconds.
    let lifetime: TimeInterval = 8

    init() {
        // Prune every second so lines fade off without piling up forever.
        // Dispatch to MainActor so @Observable's mutation is tracked by
        // SwiftUI; Timer fires on main RunLoop but @Observable expects
        // MainActor-isolated mutation to fire its observation tracker.
        pruneTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.prune() }
        }
    }

    func appendFeed(_ lines: [String]) {
        let now = Date()
        feed.append(contentsOf: lines.map { FeedLine(text: $0, at: now) })
        if feed.count > 200 { feed.removeFirst(feed.count - 200) }
    }

    @MainActor
    private func prune() {
        let cutoff = Date().addingTimeInterval(-lifetime)
        let before = feed.count
        feed.removeAll { $0.at < cutoff }
        if feed.count != before {
            // Force the @Observable tracker to notice — assign a fresh
            // array rather than mutating in place. removeAll() on an
            // @Observable array sometimes doesn't trip the change
            // observer when the array is read via .suffix().reversed()
            // in a body — the chain returns a new ArraySlice each time
            // and SwiftUI isn't tracking the underlying storage write.
            let copy = feed
            feed = []
            feed = copy
        }
    }
}
