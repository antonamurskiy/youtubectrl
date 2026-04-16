import AppIntents
import Foundation

/// Server base URL. Hardcoded for now — the Capacitor config also points here.
/// If we ever host the server elsewhere, centralise this.
private let SERVER_URL = "http://yuzu.local:3000"

/// Fallback IP in case mDNS resolution fails from the widget process.
/// (Widgets have stricter networking; mDNS may not always resolve there.)
private let SERVER_IP = "http://192.168.0.14:3000"

private func post(_ path: String, body: [String: Any]? = nil) async {
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
            _ = try await URLSession.shared.data(for: req)
            return
        } catch {
            continue
        }
    }
}

@available(iOS 17.0, *)
public struct YTCtrlPlayPauseIntent: AppIntent {
    public static var title: LocalizedStringResource = "Toggle Play/Pause"
    public static var description = IntentDescription("Toggle playback on the desktop player.")
    public init() {}
    public func perform() async throws -> some IntentResult {
        await post("/api/playpause")
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
        await post("/api/volume-bump", body: ["delta": delta])
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
