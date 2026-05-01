import Foundation
import Observation

@Observable
final class PushStore {
    private(set) var feed: [String] = []
    var apnsToken: String? = nil

    func appendFeed(_ lines: [String]) {
        feed.append(contentsOf: lines)
        if feed.count > 200 { feed.removeFirst(feed.count - 200) }
    }
}
