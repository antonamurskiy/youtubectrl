import Foundation
import Observation

@Observable
final class FeedStore {
    /// Persisted across launches so the app reopens on the last viewed
    /// tab. `@AppStorage` doesn't work inside @Observable, so we shim
    /// via didSet → UserDefaults.
    var activeTab: FeedTab = {
        if let raw = UserDefaults.standard.string(forKey: "feed.activeTab"),
           let tab = FeedTab(rawValue: raw) { return tab }
        return .rec
    }() {
        didSet { UserDefaults.standard.set(activeTab.rawValue, forKey: "feed.activeTab") }
    }
    var searchQuery: String = ""
    var channelQuery: String? = nil
    var lastError: String? = nil
    /// Bumps when the user explicitly hits the refresh FAB so the
    /// feed view can scroll to top on each press.
    var refreshTick: Int = 0

    private(set) var videosByTab: [FeedTab: [Video]] = [:]
    private(set) var shortsByTab: [FeedTab: [Short]] = [:]
    private(set) var nextPageByTab: [FeedTab: String] = [:]
    private(set) var loadingByTab: [FeedTab: Bool] = [:]
    var isCurrentTabLoading: Bool { loadingByTab[activeTab] == true }

    var currentVideos: [Video] { videosByTab[activeTab] ?? [] }
    func videosForTab(_ tab: FeedTab) -> [Video] { videosByTab[tab] ?? [] }
    var currentShorts: [Short] { shortsByTab[activeTab] ?? [] }

    func loadInitial(api: ApiClient) async {
        for tab in [FeedTab.rec] {
            await load(tab: tab, api: api)
        }
    }

    @MainActor
    func load(tab: FeedTab, api: ApiClient, append: Bool = false) async {
        if loadingByTab[tab] == true { return }
        loadingByTab[tab] = true
        defer { loadingByTab[tab] = false }
        do {
            let resp: HomeResponse
            switch tab {
            case .live: resp = try await api.live()
            case .history: resp = try await api.history()
            case .ru: resp = try await api.rumble()
            default:
                let page = append ? nextPageByTab[tab] : nil
                resp = try await api.home(feed: tab.feedKey, page: page)
            }
            let newVideos = resp.videos ?? []
            if append {
                var existing = videosByTab[tab] ?? []
                existing.append(contentsOf: newVideos)
                videosByTab[tab] = existing
            } else {
                videosByTab[tab] = newVideos
                shortsByTab[tab] = resp.shorts ?? []
            }
            if let next = resp.nextPage { nextPageByTab[tab] = next }
            else { nextPageByTab[tab] = nil }
        } catch {
            lastError = "\(tab.rawValue): \(String(describing: error))"
            print("[Feed] load(\(tab.rawValue)) failed: \(error)")
        }
    }

    @MainActor
    func search(_ query: String, api: ApiClient) async {
        searchQuery = query
        guard !query.isEmpty else { return }
        do {
            let resp = try await api.search(query)
            videosByTab[.rec] = resp.videos ?? []
        } catch {}
    }

    @MainActor
    func loadChannel(id: String?, name: String?, api: ApiClient) async {
        channelQuery = id ?? name
        do {
            let resp = try await api.channel(id: id, name: name)
            videosByTab[.rec] = resp.videos ?? []
            shortsByTab[.rec] = []
            activeTab = .rec
        } catch {
            lastError = "channel: \(error)"
        }
    }

    @MainActor
    func clearChannel() {
        channelQuery = nil
    }
}
