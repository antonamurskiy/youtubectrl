import AppIntents
import Foundation
import ActivityKit

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
            for act in Activity<YouTubeCtrlActivityAttributes>.activities {
                var state = act.content.state
                state.paused.toggle()
                await act.update(.init(state: state, staleDate: nil))
            }
        }
        Task.detached {
            _ = await post("/api/playpause")
        }
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
        // Optimistically update the widget FIRST — based on the current
        // ContentState volume + delta. This makes the slider respond instantly
        // rather than waiting for the HTTP round trip.
        if #available(iOS 16.2, *) {
            for act in Activity<YouTubeCtrlActivityAttributes>.activities {
                var state = act.content.state
                state.volume = max(0, min(100, state.volume + delta))
                await act.update(.init(state: state, staleDate: nil))
            }
        }
        // Fire the server request without awaiting its completion so the
        // intent returns quickly — iOS gives us limited time per intent.
        Task.detached {
            _ = await post("/api/volume-bump", body: ["delta": delta])
        }
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
