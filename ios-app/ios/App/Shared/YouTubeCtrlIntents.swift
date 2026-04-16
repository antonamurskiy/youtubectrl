import AppIntents
import Foundation
import ActivityKit

// Cross-invocation state for widget intents. Intents run as short-lived
// processes, but static state persists within the widget extension's
// process while it's alive, which is enough for rapid-tap coalescing.
private actor IntentCoalescer {
    static let shared = IntentCoalescer()
    private var pendingVolumeDelta = 0
    private var pendingBumpTask: Task<Void, Never>?
    private var lastUpdateAt: Date = .distantPast

    func queueVolumeBump(_ delta: Int) async {
        pendingVolumeDelta += delta
        pendingBumpTask?.cancel()
        let toSend = pendingVolumeDelta
        pendingBumpTask = Task {
            // Wait 250ms for more taps to pile up
            try? await Task.sleep(nanoseconds: 250_000_000)
            if Task.isCancelled { return }
            await IntentCoalescer.shared.flushBump(toSend)
        }
    }

    func flushBump(_ delta: Int) async {
        guard pendingVolumeDelta == delta else { return }
        pendingVolumeDelta = 0
        pendingBumpTask = nil
        _ = await post("/api/volume-bump", body: ["delta": delta])
    }

    func canUpdateActivity() -> Bool {
        let now = Date()
        if now.timeIntervalSince(lastUpdateAt) < 0.35 { return false }
        lastUpdateAt = now
        return true
    }

    func scheduleDelayedUpdate() {
        Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            await IntentCoalescer.shared.drainPending()
        }
    }

    private var pendingVolumeTarget: Int?
    private var pendingPausedTarget: Bool?

    func latch(volume: Int? = nil, paused: Bool? = nil) {
        if let v = volume { pendingVolumeTarget = v }
        if let p = paused { pendingPausedTarget = p }
    }

    func drainPending() async {
        let v = pendingVolumeTarget
        let p = pendingPausedTarget
        pendingVolumeTarget = nil
        pendingPausedTarget = nil
        guard v != nil || p != nil else { return }
        lastUpdateAt = Date()
        if #available(iOS 16.2, *) {
            for act in Activity<YouTubeCtrlActivityAttributes>.activities {
                var state = act.content.state
                if let v = v { state.volume = v }
                if let p = p { state.paused = p }
                await act.update(.init(state: state, staleDate: nil))
            }
        }
    }
}

/// Server base URL. Hardcoded for now — the Capacitor config also points here.
/// If we ever host the server elsewhere, centralise this.
private let SERVER_URL = "http://yuzu.local:3000"

/// Fallback IP in case mDNS resolution fails from the widget process.
/// (Widgets have stricter networking; mDNS may not always resolve there.)
private let SERVER_IP = "http://192.168.0.14:3000"

@discardableResult
private func post(_ path: String, body: [String: Any]? = nil) async -> [String: Any]? {
    for base in [SERVER_URL, SERVER_IP] {
        guard let url = URL(string: "\(base)\(path)") else { continue }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 1.5
        if let body = body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return json
            }
            return [:]
        } catch {
            continue
        }
    }
    return nil
}

// Updates the currently-running Live Activity's volume field directly
// from within an intent. Needed because the activity runs in a different
// process from the main app — we can't round-trip through the JS layer
// when the main app is suspended or backgrounded.
@available(iOS 16.2, *)
private func updateActivityVolume(_ volume: Int) async {
    for act in Activity<YouTubeCtrlActivityAttributes>.activities {
        var state = act.content.state
        state.volume = volume
        await act.update(.init(state: state, staleDate: nil))
    }
}

@available(iOS 16.2, *)
private func updateActivityPaused(_ paused: Bool) async {
    for act in Activity<YouTubeCtrlActivityAttributes>.activities {
        var state = act.content.state
        state.paused = paused
        await act.update(.init(state: state, staleDate: nil))
    }
}

@available(iOS 17.0, *)
public struct YTCtrlPlayPauseIntent: AppIntent {
    public static var title: LocalizedStringResource = "Toggle Play/Pause"
    public static var description = IntentDescription("Toggle playback on the desktop player.")
    public init() {}
    public func perform() async throws -> some IntentResult {
        if #available(iOS 16.2, *) {
            // Compute target paused state from current activity
            var targetPaused = false
            for act in Activity<YouTubeCtrlActivityAttributes>.activities {
                targetPaused = !act.content.state.paused
                break
            }
            let canUpdate = await IntentCoalescer.shared.canUpdateActivity()
            if canUpdate {
                for act in Activity<YouTubeCtrlActivityAttributes>.activities {
                    var state = act.content.state
                    state.paused = targetPaused
                    await act.update(.init(state: state, staleDate: nil))
                }
            } else {
                await IntentCoalescer.shared.latch(paused: targetPaused)
                await IntentCoalescer.shared.scheduleDelayedUpdate()
            }
        }
        Task.detached { _ = await post("/api/playpause") }
        return .result()
    }
}

@available(iOS 17.0, *)
public struct YTCtrlSkipIntent: AppIntent {
    public static var title: LocalizedStringResource = "Skip"
    public init() {}
    @Parameter(title: "Seconds")
    public var delta: Int
    public init(delta: Int) { self.delta = delta }
    public func perform() async throws -> some IntentResult {
        await post("/api/seek-relative", body: ["offset": delta])
        return .result()
    }
}

@available(iOS 17.0, *)
public struct YTCtrlVolumeIntent: AppIntent {
    public static var title: LocalizedStringResource = "Adjust Volume"
    public init() {}
    @Parameter(title: "Delta")
    public var delta: Int
    public init(delta: Int) { self.delta = delta }
    public func perform() async throws -> some IntentResult {
        if #available(iOS 16.2, *) {
            // Read current volume from activity + apply delta locally
            var targetVolume = 50
            for act in Activity<YouTubeCtrlActivityAttributes>.activities {
                targetVolume = max(0, min(100, act.content.state.volume + delta))
                break
            }
            let canUpdate = await IntentCoalescer.shared.canUpdateActivity()
            if canUpdate {
                for act in Activity<YouTubeCtrlActivityAttributes>.activities {
                    var state = act.content.state
                    state.volume = targetVolume
                    await act.update(.init(state: state, staleDate: nil))
                }
            } else {
                // Latch the target; a drain task will flush it after cooldown
                await IntentCoalescer.shared.latch(volume: targetVolume)
                await IntentCoalescer.shared.scheduleDelayedUpdate()
            }
        }
        // Debounced server call
        await IntentCoalescer.shared.queueVolumeBump(delta)
        return .result()
    }
}

@available(iOS 17.0, *)
public struct YTCtrlMuteIntent: AppIntent {
    public static var title: LocalizedStringResource = "Toggle Mute"
    public init() {}
    public func perform() async throws -> some IntentResult {
        await post("/api/mute")
        return .result()
    }
}
