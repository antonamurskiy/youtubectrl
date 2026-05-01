import Foundation

struct Video: Codable, Hashable, Identifiable {
    let videoId: String?
    let url: String?
    let title: String?
    let channel: String?
    let channelId: String?
    let thumbnail: String?
    let duration: String?
    let views: String?
    let uploadedAt: String?
    let isLive: Bool?
    let live: Bool?
    let upcoming: Bool?
    let startPercent: Double?
    let notInterestedToken: String?
    let savedPosition: Double?
    let savedDuration: Double?

    // Server uses `id`, `videoId` is what client computes locally —
    // accept both. Identifiable id falls through to derived URL.
    var id: String { videoId ?? url ?? UUID().uuidString }

    enum CodingKeys: String, CodingKey {
        case videoId, id, url, title, channel, channelId, thumbnail
        case duration, views, uploadedAt, isLive, live, upcoming, startPercent
        case notInterestedToken, savedPosition, savedDuration
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        videoId = (try? c.decode(String.self, forKey: .videoId)) ?? (try? c.decode(String.self, forKey: .id))
        url = try? c.decode(String.self, forKey: .url)
        title = try? c.decode(String.self, forKey: .title)
        channel = try? c.decode(String.self, forKey: .channel)
        channelId = try? c.decode(String.self, forKey: .channelId)
        thumbnail = try? c.decode(String.self, forKey: .thumbnail)
        duration = Self.decodeFlexibleString(c, key: .duration)
        views = Self.decodeFlexibleString(c, key: .views)
        uploadedAt = try? c.decode(String.self, forKey: .uploadedAt)
        isLive = try? c.decode(Bool.self, forKey: .isLive)
        live = try? c.decode(Bool.self, forKey: .live)
        upcoming = try? c.decode(Bool.self, forKey: .upcoming)
        startPercent = try? c.decode(Double.self, forKey: .startPercent)
        notInterestedToken = try? c.decode(String.self, forKey: .notInterestedToken)
        savedPosition = try? c.decode(Double.self, forKey: .savedPosition)
        savedDuration = try? c.decode(Double.self, forKey: .savedDuration)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(videoId, forKey: .videoId)
        try c.encodeIfPresent(url, forKey: .url)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(channel, forKey: .channel)
        try c.encodeIfPresent(channelId, forKey: .channelId)
        try c.encodeIfPresent(thumbnail, forKey: .thumbnail)
        try c.encodeIfPresent(duration, forKey: .duration)
        try c.encodeIfPresent(views, forKey: .views)
        try c.encodeIfPresent(uploadedAt, forKey: .uploadedAt)
        try c.encodeIfPresent(isLive, forKey: .isLive)
        try c.encodeIfPresent(live, forKey: .live)
        try c.encodeIfPresent(upcoming, forKey: .upcoming)
        try c.encodeIfPresent(startPercent, forKey: .startPercent)
    }

    /// Server returns `views` as either a number ("11000") or a
    /// formatted string ("11K views"). Coerce to string either way.
    private static func decodeFlexibleString<K: CodingKey>(_ c: KeyedDecodingContainer<K>, key: K) -> String? {
        if let s = try? c.decode(String.self, forKey: key) { return s }
        if let i = try? c.decode(Int.self, forKey: key) { return String(i) }
        if let d = try? c.decode(Double.self, forKey: key) { return String(d) }
        return nil
    }
}

struct Short: Codable, Hashable, Identifiable {
    let videoId: String?
    let title: String?
    let thumbnail: String?
    let views: String?

    var id: String { videoId ?? UUID().uuidString }

    enum CodingKeys: String, CodingKey { case videoId, id, title, thumbnail, views }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        videoId = (try? c.decode(String.self, forKey: .videoId)) ?? (try? c.decode(String.self, forKey: .id))
        title = try? c.decode(String.self, forKey: .title)
        thumbnail = try? c.decode(String.self, forKey: .thumbnail)
        if let s = try? c.decode(String.self, forKey: .views) { views = s }
        else if let i = try? c.decode(Int.self, forKey: .views) { views = String(i) }
        else { views = nil }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(videoId, forKey: .videoId)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(thumbnail, forKey: .thumbnail)
        try c.encodeIfPresent(views, forKey: .views)
    }
}

struct HomeResponse: Codable {
    let videos: [Video]?
    let shorts: [Short]?
    let nextPage: String?
}

struct MacStatus: Codable, Hashable {
    let locked: Bool?
    let screenOff: Bool?
    let ethernet: Bool?
    let keepAwake: Bool?
    let frontApp: String?
}

struct TmuxWindow: Codable, Hashable, Identifiable {
    var id: Int { index }
    let index: Int
    let name: String
    let active: Bool
    let title: String?
}

struct PlaybackPayload: Codable {
    let playing: Bool?
    let url: String?
    let title: String?
    let channel: String?
    let thumbnail: String?
    let position: Double?
    let duration: Double?
    let paused: Bool?
    let isLive: Bool?
    let isPostLive: Bool?
    let dvrActive: Bool?
    let player: String?
    let monitor: String?
    let windowMode: String?
    let visible: Bool?
    let speed: Double?
    let serverTs: Double?
    let absoluteMs: Double?
    let phoneSyncOk: Bool?
    let macStatus: MacStatus?
    let tmuxWindows: [TmuxWindow]?
    let tmuxColors: [String: String]?
    let claudeState: String?
    let claudeOptions: [ClaudeOption]?
    let claudeQuestion: String?
}

struct ClaudeOption: Codable, Hashable {
    let n: Int
    let text: String
}

struct ClaudePayload: Codable {
    let claudeState: String?
    let claudeOptions: [ClaudeOption]?
    let claudeQuestion: String?
}

struct TmuxBroadcast: Codable {
    let windows: [TmuxWindow]
    let colors: [String: String]?
}

enum FeedTab: String, CaseIterable, Identifiable {
    case rec, live, subs, ru, history
    var id: String { rawValue }
    var label: String {
        switch self {
        case .rec: "Rec"
        case .live: "Live"
        case .subs: "Subs"
        case .ru: "Ru"
        case .history: "Hist"
        }
    }
    var feedKey: String {
        switch self {
        case .rec: "recommended"
        case .subs: "subscriptions"
        default: rawValue
        }
    }
}
