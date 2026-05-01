import Foundation
import Observation

@Observable
final class FeedStore {
    var activeTab: FeedTab = .rec
    var searchQuery: String = ""
    var channelQuery: String? = nil
    var lastError: String? = nil

    private(set) var videosByTab: [FeedTab: [Video]] = [:]
    private(set) var shortsByTab: [FeedTab: [Short]] = [:]
    private(set) var nextPageByTab: [FeedTab: String] = [:]
    private(set) var loadingByTab: [FeedTab: Bool] = [:]

    var currentVideos: [Video] { videosByTab[activeTab] ?? [] }
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
