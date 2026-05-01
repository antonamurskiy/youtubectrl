import Foundation
import Observation

enum PhoneMode: String { case computer, sync, phoneOnly }

@Observable
final class PhoneModeStore {
    var mode: PhoneMode = .computer
    var loading: Bool = false
    var lastUrl: String? = nil
    var lastError: String? = nil

    @MainActor
    func toggle(services: ServiceContainer) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        if mode == .computer { await switchToSync(services: services) }
        else { await switchToComputer(services: services) }
    }

    @MainActor
    func switchToSync(services: ServiceContainer) async {
        do {
            let resp = try await services.api.watchOnPhone()
            // Prefer DASH composition when both URLs are present, else
            // single streamUrl (HLS for live, MP4 for VOD).
            if let v = resp.videoUrl, let a = resp.audioUrl,
               let vu = URL(string: v), let au = URL(string: a) {
                try await services.avHost.loadDASH(videoURL: vu, audioURL: au, durationHint: resp.durationSec ?? 0,
                                                    position: resp.seconds ?? 0, autoplay: true, muted: false)
            } else if let s = resp.streamUrl, let u = URL(string: s) {
                services.avHost.load(url: u, position: resp.seconds ?? 0, autoplay: true, muted: false)
            } else {
                lastError = "no streamUrl from server"
                return
            }
            lastUrl = resp.streamUrl ?? resp.videoUrl
            mode = .sync
            services.avHost.enableVolumeIntercept()
            // Now Playing on lock screen — title/channel come from the playback store
            services.avHost.setNowPlaying(
                title: services.playback.title,
                channel: services.playback.channel,
                durationSec: services.playback.duration,
                positionSec: resp.seconds ?? 0,
                isLive: resp.isLive ?? false,
                artworkURL: services.playback.thumbnail
            )
            if resp.isLive == true {
                services.liveSync.reset()
                services.liveSync.start()
            }
        } catch {
            lastError = String(describing: error)
        }
    }

    @MainActor
    func startPhoneOnly(url: String, services: ServiceContainer) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let resp = try await services.api.phoneOnly(url: url)
            if let v = resp.videoUrl, let a = resp.audioUrl,
               let vu = URL(string: v), let au = URL(string: a) {
                try await services.avHost.loadDASH(videoURL: vu, audioURL: au, durationHint: resp.durationSec ?? 0,
                                                    position: 0, autoplay: true, muted: false)
            } else if let s = resp.streamUrl, let u = URL(string: s) {
                services.avHost.load(url: u, position: 0, autoplay: true, muted: false)
            } else {
                lastError = "phone-only: no streamUrl"
                return
            }
            mode = .phoneOnly
            // No live sync in phone-only mode (mpv is paused/hidden, AVPlayer is authoritative).
        } catch {
            lastError = "phone-only: \(error)"
        }
    }

    @MainActor
    func switchToComputer(services: ServiceContainer) async {
        services.liveSync.stop()
        services.avHost.disableVolumeIntercept()
        services.avHost.stop()
        services.avHost.clearNowPlaying()
        try? await services.api.stopPhoneStream()
        mode = .computer
    }
}
