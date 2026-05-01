import Foundation

struct Video: Codable, Hashable, Identifiable {
    var id: String { videoId ?? url ?? UUID().uuidString }
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
}

struct Short: Codable, Hashable, Identifiable {
    var id: String { videoId ?? UUID().uuidString }
    let videoId: String?
    let title: String?
    let thumbnail: String?
    let views: String?
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
