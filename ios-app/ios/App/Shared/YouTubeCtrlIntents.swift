import AppIntents
import Foundation
import ActivityKit

private let SERVER_URL = "http://yuzu.local:3000"
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
        } catch { continue }
    }
    return nil
}

@available(iOS 16.2, *)
private func updateAllActivities(_ mutate: (inout YouTubeCtrlActivityAttributes.ContentState) -> Void) async {
    for act in Activity<YouTubeCtrlActivityAttributes>.activities {
        var state = act.content.state
        mutate(&state)
        // staleDate of 1 minute helps iOS prioritise our update
        await act.update(
            ActivityContent(state: state, staleDate: Date().addingTimeInterval(60))
        )
    }
}

@available(iOS 17.0, *)
public struct YTCtrlPlayPauseIntent: AppIntent {
    public static var title: LocalizedStringResource = "Toggle Play/Pause"
    public init() {}
    public func perform() async throws -> some IntentResult {
        if #available(iOS 16.2, *) {
            await updateAllActivities { $0.paused.toggle() }
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
        Task.detached { _ = await post("/api/seek-relative", body: ["offset": delta]) }
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
        // Optimistic widget update — read-modify-write from current state
        if #available(iOS 16.2, *) {
            await updateAllActivities { state in
                state.volume = max(0, min(100, state.volume + delta))
            }
        }
        Task.detached { _ = await post("/api/volume-bump", body: ["delta": delta]) }
        return .result()
    }
}

@available(iOS 17.0, *)
public struct YTCtrlMuteIntent: AppIntent {
    public static var title: LocalizedStringResource = "Toggle Mute"
    public init() {}
    public func perform() async throws -> some IntentResult {
        Task.detached { _ = await post("/api/mute") }
        return .result()
    }
}
