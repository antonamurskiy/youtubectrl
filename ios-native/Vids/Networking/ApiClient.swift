import Foundation

actor ApiClient {
    var host: String
    private let decoder = JSONDecoder()
    private let session: URLSession

    init(host: String) {
        self.host = host
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        self.session = URLSession(configuration: config)
    }

    func setHost(_ host: String) { self.host = host }

    private func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var c = URLComponents()
        c.scheme = "http"
        let parts = host.split(separator: ":", maxSplits: 1).map(String.init)
        c.host = parts.first
        if parts.count > 1, let port = Int(parts[1]) { c.port = port }
        c.path = path
        if !query.isEmpty { c.queryItems = query }
        return c.url!
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let (data, _) = try await session.data(from: url(path, query: query))
        return try decoder.decode(T.self, from: data)
    }

    private func post(_ path: String, body: [String: Any] = [:]) async throws {
        var req = URLRequest(url: url(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        _ = try await session.data(for: req)
    }

    func home(feed: String, page: String? = nil) async throws -> HomeResponse {
        var q = [URLQueryItem(name: "feed", value: feed)]
        if let p = page { q.append(URLQueryItem(name: "page", value: p)) }
        return try await get("/api/home", query: q)
    }

    func search(_ query: String) async throws -> HomeResponse {
        try await get("/api/search", query: [URLQueryItem(name: "q", value: query)])
    }

    func live() async throws -> HomeResponse { try await get("/api/live") }
    func history() async throws -> HomeResponse { try await get("/api/history") }
    func trending() async throws -> HomeResponse { try await get("/api/trending") }

    func play(url: String, title: String? = nil, channel: String? = nil, thumbnail: String? = nil, isLive: Bool? = nil, startPercent: Double? = nil) async throws {
        var body: [String: Any] = ["url": url]
        if let title { body["title"] = title }
        if let channel { body["channel"] = channel }
        if let thumbnail { body["thumbnail"] = thumbnail }
        if let isLive { body["isLive"] = isLive }
        if let startPercent { body["startPercent"] = startPercent }
        try await post("/api/play", body: body)
    }

    func playPause() async throws { try await post("/api/playpause") }
    func seek(_ seconds: Double) async throws { try await post("/api/seek", body: ["position": seconds]) }
    func skip(_ delta: Double) async throws { try await post("/api/skip", body: ["delta": delta]) }
    func goLive() async throws { try await post("/api/go-live") }
    func stop() async throws { try await post("/api/stop") }
    func toggleVisibility() async throws { try await post("/api/toggle-visibility") }
    func volumeBump(_ delta: Int) async throws { try await post("/api/volume-bump", body: ["delta": delta]) }
    func tmuxSelect(index: Int) async throws { try await post("/api/tmux-select", body: ["index": index]) }
    func tmuxSend(_ keys: String) async throws { try await post("/api/tmux-send", body: ["keys": keys]) }
    func tmuxRename(index: Int, name: String) async throws { try await post("/api/tmux-rename", body: ["index": index, "name": name]) }
    func tmuxColor(name: String, color: String) async throws { try await post("/api/tmux-color", body: ["name": name, "color": color]) }

    func registerAPNS(token: String) async throws {
        try await post("/api/apns-register", body: ["token": token])
    }

    struct WatchOnPhoneResponse: Codable {
        let streamUrl: String?
        let videoUrl: String?
        let audioUrl: String?
        let seconds: Double?
        let videoId: String?
        let isLive: Bool?
        let durationSec: Double?
    }

    func watchOnPhone() async throws -> WatchOnPhoneResponse {
        var req = URLRequest(url: url("/api/watch-on-phone"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [String: Any]())
        let (data, _) = try await session.data(for: req)
        return try decoder.decode(WatchOnPhoneResponse.self, from: data)
    }

    func stopPhoneStream() async throws {
        try await post("/api/stop-phone-stream")
    }

    func previewURL(videoId: String, isLive: Bool = false) async throws -> String? {
        var q = [URLQueryItem(name: "id", value: videoId)]
        if isLive { q.append(URLQueryItem(name: "live", value: "1")) }
        struct Resp: Codable { let url: String? }
        let r: Resp = try await get("/api/preview-url", query: q)
        return r.url
    }
}
