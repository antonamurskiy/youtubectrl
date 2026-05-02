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

    /// Re-fetches /api/watch-on-phone and reloads the AVPlayer with the
    /// new URL — used when mpv switches videos while sync mode is active.
    /// Uses pause→replaceCurrentItem→play so PiP doesn't get stuck on
    /// the previous frame.
    @MainActor
    func reloadForCurrentVideo(services: ServiceContainer) async {
        guard mode == .sync else { return }
        await switchToSync(services: services)
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
                await services.ui.toast("Watch-on-phone: no stream URL")
                return
            }
            mode = .phoneOnly
            // Volume buttons must NOT drive the Mac in phone-only —
            // they should change AirPods/headphones volume natively.
            services.avHost.disableVolumeIntercept()
            // Phone-only state isn't reflected in the server playback
            // broadcast, so the scrubber would read playback.duration=0
            // and seek to the start every time. Seed the store with
            // the Rumble/YouTube duration we got from /api/phone-only.
            services.playback.playing = true
            services.playback.url = url
            services.playback.duration = resp.durationSec ?? 0
            services.playback.isLive = resp.isLive ?? false
            services.playback.player = "phone"
            // Drive the scrubber off AVPlayer's currentTime (mpv on
            // the Mac is muted/hidden so the server's position broadcast
            // is meaningless).
            services.avHost.startProgressUpdates { [weak services] sec in
                services?.playback.position = sec
                if let h = services?.avHost.currentItemDurationSeconds, h > 0 {
                    services?.playback.duration = h
                }
                // Reset interpolation so ScrubberView's CADisplayLink
                // uses our written position directly instead of a stale
                // serverTs-anchored value.
                services?.playback.serverTs = 0
            }
            // No live sync in phone-only mode (mpv is paused/hidden, AVPlayer is authoritative).
        } catch {
            lastError = "phone-only: \(error)"
            await services.ui.toast("Watch-on-phone failed: \(error.localizedDescription)")
        }
    }

    @MainActor
    func switchToComputer(services: ServiceContainer) async {
        services.liveSync.stop()
        services.avHost.disableVolumeIntercept()
        services.avHost.stopProgressUpdates()
        services.avHost.stop()
        services.avHost.clearNowPlaying()
        try? await services.api.stopPhoneStream()
        mode = .computer
    }
}
