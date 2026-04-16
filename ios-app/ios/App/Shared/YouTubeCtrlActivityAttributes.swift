import ActivityKit
import Foundation

/// Shared state contract between the main app and the Live Activity widget.
/// Static attributes are fixed for the lifetime of the activity; ContentState
/// is what the app updates as playback / volume change.
public struct YouTubeCtrlActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var title: String
        public var channel: String
        public var artworkUrl: String
        public var volume: Int        // 0–100
        public var paused: Bool
        public var position: Double   // seconds
        public var duration: Double   // 0 if live
        public var isLive: Bool

        public init(title: String, channel: String, artworkUrl: String, volume: Int, paused: Bool, position: Double, duration: Double, isLive: Bool) {
            self.title = title
            self.channel = channel
            self.artworkUrl = artworkUrl
            self.volume = volume
            self.paused = paused
            self.position = position
            self.duration = duration
            self.isLive = isLive
        }
    }

    public init() {}
}
