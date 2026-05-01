import Foundation
import SwiftUI

@Observable
final class ServiceContainer {
    var serverHost: String = "yuzu.local:3000"

    let api: ApiClient
    let ws: WSClient
    let playback: PlaybackStore
    let feed: FeedStore
    let terminal: TerminalStore
    let theme: ThemeStore
    let push: PushStore
    let ui: UIStore
    let avHost: AVPlayerHost
    let liveSync: LiveSyncEngine

    init() {
        self.api = ApiClient(host: "yuzu.local:3000")
        self.playback = PlaybackStore()
        self.feed = FeedStore()
        self.terminal = TerminalStore()
        self.theme = ThemeStore()
        self.push = PushStore()
        self.ui = UIStore()
        self.avHost = AVPlayerHost()
        self.liveSync = LiveSyncEngine()
        self.ws = WSClient(host: "yuzu.local:3000")
        self.ws.onMessage = { [weak self] msg in
            guard let self else { return }
            switch msg {
            case .playback(let p):
                self.playback.apply(p)
                self.terminal.apply(windows: p.tmuxWindows, colors: p.tmuxColors)
                if let pdt = p.absoluteMs, let ts = p.serverTs {
                    self.liveSync.setServerPDT(pdt, serverTs: ts)
                    self.liveSync.updateClockOffset(self.ws.clockOffset)
                }
            case .tmux(let t):
                self.terminal.apply(windows: t.windows, colors: t.colors)
            case .claudeFeed(let lines):
                self.push.appendFeed(lines)
            case .claude(let c):
                self.playback.applyClaude(c)
            }
        }
        // Wire AVPlayerHost callbacks to the server API.
        self.avHost.onRemotePlayPause = { [weak self] in
            Task { try? await self?.api.playPause() }
        }
        self.avHost.onRemoteSkip = { [weak self] delta in
            Task { try? await self?.api.skip(delta) }
        }
        self.avHost.onRemoteSeek = { [weak self] sec in
            Task { try? await self?.api.seek(sec) }
        }
        self.avHost.onVolumeButton = { [weak self] step in
            Task { try? await self?.api.volumeBump(step) }
        }
        self.liveSync.attach(host: self.avHost, clockOffset: 0)
    }

    func start() async {
        PushHandler.shared.services = self
        ws.connect()
        await feed.loadInitial(api: api)
    }

    func handleDeepLink(_ url: URL) {
        guard url.scheme == "youtubectrl" else { return }
        if url.host == "play",
           let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
           let target = q.first(where: { $0.name == "url" })?.value {
            Task { try? await api.play(url: target) }
        }
    }
}
