import Foundation
import Observation

@Observable
final class PlaybackStore {
    var playing: Bool = false
    var url: String = ""
    var title: String = ""
    var channel: String = ""
    var thumbnail: String = ""
    var position: Double = 0
    var duration: Double = 0
    var paused: Bool = false
    var isLive: Bool = false
    var isPostLive: Bool = false
    var dvrActive: Bool = false
    var player: String? = nil
    var monitor: String = "lg"
    var windowMode: String? = nil
    var visible: Bool = true
    var speed: Double = 1.0
    var serverTs: Double = 0
    var absoluteMs: Double? = nil
    var phoneSyncOk: Bool = true

    var macStatus = MacStatus(locked: false, screenOff: false, ethernet: false, keepAwake: false, frontApp: nil)
    var audioOutput: String = ""
    var audioBattery: Int? = nil
    var claudeState: String = "idle"
    var claudeOptions: [ClaudeOption] = []
    var claudeQuestion: String? = nil

    var storyboard: ApiClient.Storyboard? = nil
    var storyboardForUrl: String? = nil

    func apply(_ p: PlaybackPayload) {
        if let v = p.playing { playing = v }
        if let v = p.url { url = v }
        if let v = p.title { title = v }
        if let v = p.channel { channel = v }
        if let v = p.thumbnail { thumbnail = v }
        if let v = p.position { position = v }
        if let v = p.duration { duration = v }
        if let v = p.paused { paused = v }
        if let v = p.isLive { isLive = v }
        if let v = p.isPostLive { isPostLive = v }
        if let v = p.dvrActive { dvrActive = v }
        if let v = p.player { player = v }
        if let v = p.monitor { monitor = v }
        if let v = p.windowMode { windowMode = v }
        if let v = p.visible { visible = v }
        if let v = p.speed { speed = v }
        if let v = p.serverTs { serverTs = v }
        if let v = p.absoluteMs { absoluteMs = v }
        if let v = p.phoneSyncOk { phoneSyncOk = v }
        if let v = p.macStatus, v != macStatus { macStatus = v }
        if let v = p.audioOutput { audioOutput = v }
        if let v = p.audioBattery { audioBattery = v }
        if let v = p.claudeState, v != claudeState { claudeState = v }
        if let v = p.claudeOptions, v != claudeOptions { claudeOptions = v }
        if let v = p.claudeQuestion, v != claudeQuestion { claudeQuestion = v }
    }

    func applyClaude(_ c: ClaudePayload) {
        if let v = c.claudeState { claudeState = v }
        if let v = c.claudeOptions { claudeOptions = v }
        if let v = c.claudeQuestion { claudeQuestion = v }
    }

    /// Wall-clock-interpolated position. Drives the scrubber CADisplayLink.
    func interpolatedPosition(now: Double = Date().timeIntervalSince1970 * 1000, clockOffset: Double) -> Double {
        guard playing && !paused, serverTs > 0 else { return position }
        let elapsed = max(0, min(2000, now + clockOffset - serverTs)) / 1000
        return min(duration > 0 ? duration : position + elapsed, position + elapsed * speed)
    }
}
