import Foundation
import Observation
import AVFoundation

enum PhoneMode: String { case computer, sync, phoneOnly }

@Observable
final class PhoneModeStore {
    var mode: PhoneMode = .computer
    var loading: Bool = false
    var lastUrl: String? = nil
    var lastError: String? = nil

    /// Current iPhone audio output route. Tracked here so NowPlayingBar
    /// can show the phone's output (AirPods, phone speaker, etc.) when
    /// audio is coming out of the phone, instead of the Mac's output.
    var phoneAudioOutput: String = ""
    var phoneAudioPortType: String = ""

    @ObservationIgnored
    private var routeObserver: NSObjectProtocol?

    init() {
        refreshPhoneAudioRoute()
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            self?.refreshPhoneAudioRoute()
        }
    }

    deinit {
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
    }

    private func refreshPhoneAudioRoute() {
        let route = AVAudioSession.sharedInstance().currentRoute
        guard let out = route.outputs.first else {
            phoneAudioOutput = ""
            phoneAudioPortType = ""
            return
        }
        phoneAudioOutput = out.portName
        phoneAudioPortType = out.portType.rawValue
    }

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
        // Flip the mode flag immediately so the audio-destination
        // badge + view-mode button update on tap, not 5-10s later
        // when /api/watch-on-phone returns. On error we revert below.
        let prevMode = mode
        mode = .sync
        // Warm-path: same URL still loaded on AVPlayer from a previous
        // sync session. Just unmute + play instead of refetching the
        // stream URL. Lets the user toggle Phone↔PC instantly without
        // re-spawning a download / re-resolving via yt-dlp.
        if lastUrl != nil, lastUrl == services.playback.url,
           services.avHost.player.currentItem != nil {
            services.avHost.setMuted(false)
            services.avHost.play()
            services.avHost.enableVolumeIntercept()
            // Re-show inline layer so video/PiP can render.
            // (Frame gets sized correctly by PhonePlayerView on next layout.)
            if services.playback.isLive {
                services.liveSync.reset()
                services.liveSync.start()
                services.vodSync.stop()
            } else {
                services.liveSync.stop()
                services.vodSync.start()
            }
            await applyHeadphoneRouting(services: services)
            return
        }
        do {
            let resp = try await services.api.watchOnPhone()
            // Prefer DASH composition when both URLs are present, else
            // single streamUrl (HLS for live, MP4 for VOD).
            // Load muted=true so the iPhone speaker never fires
            // even briefly while applyHeadphoneRouting is in flight.
            // Routing then unmutes if the phone has headphones.
            if let v = resp.videoUrl, let a = resp.audioUrl,
               let vu = URL(string: v), let au = URL(string: a) {
                try await services.avHost.loadDASH(videoURL: vu, audioURL: au, durationHint: resp.durationSec ?? 0,
                                                    position: resp.seconds ?? 0, autoplay: true, muted: true)
            } else if let s = resp.streamUrl, let u = URL(string: s) {
                services.avHost.load(url: u, position: resp.seconds ?? 0, autoplay: true, muted: true)
            } else {
                lastError = "no streamUrl from server"
                mode = prevMode
                return
            }
            lastUrl = resp.streamUrl ?? resp.videoUrl
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
                services.vodSync.stop()
            } else {
                services.liveSync.stop()
                services.vodSync.start()
            }
            // Headphone-side detection: in sync mode play on whichever
            // device has the headphones, mute the other. iPhone wins
            // ties (its AVPlayer is the active rendering surface).
            await applyHeadphoneRouting(services: services)
        } catch {
            lastError = String(describing: error)
            mode = prevMode
        }
    }

    @MainActor
    func startPhoneOnly(url: String, services: ServiceContainer) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let resp = try await services.api.phoneOnly(url: url)
            // Try DASH composition first (1080p YouTube — separate
            // video+audio streams). If it throws (network, parse,
            // missing track), fall back to single-stream load with
            // streamUrl. Rumble always lands here directly.
            var loaded = false
            if let v = resp.videoUrl, let a = resp.audioUrl,
               let vu = URL(string: v), let au = URL(string: a) {
                do {
                    try await services.avHost.loadDASH(videoURL: vu, audioURL: au,
                                                        durationHint: resp.durationSec ?? 0,
                                                        position: 0, autoplay: true, muted: false)
                    loaded = true
                } catch {
                    NSLog("[phone-only] DASH load failed: \(error) — falling back to streamUrl")
                }
            }
            if !loaded, let s = resp.streamUrl, let u = URL(string: s) {
                services.avHost.load(url: u, position: 0, autoplay: true, muted: false)
                loaded = true
            }
            if !loaded {
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
        // Keep AVPlayer warm — pause + mute + hide instead of
        // stop()/replaceCurrentItem. Re-entering sync then just
        // unmutes + plays an already-loaded item, no yt-dlp resolve
        // and no DASH composition rebuild. Cuts mode-switch latency
        // from ~5-10s to <1s.
        services.liveSync.stop()
        services.vodSync.stop()
        services.avHost.disableVolumeIntercept()
        services.avHost.stopProgressUpdates()
        services.avHost.pause()
        services.avHost.setMuted(true)
        // Hide the inline layer so PiP can't show the (now stale)
        // frame on top of mpv's resumed video. Stop PiP if active.
        services.avHost.setLayerFrame(.zero, visible: false)
        if services.avHost.pipActive { services.avHost.stopPip() }
        try? await services.api.stopPhoneStream()
        // Restore Mac mute state — sync mode may have muted it.
        try? await services.api.setMacMute(false)
        mode = .computer
    }

    /// In sync mode, route audio to one side only. Mac is the
    /// default playback device. Phone takes over only when phone
    /// itself has headphones attached (BT A2DP/HFP, wired, USB).
    /// This avoids the "iPhone speaker doubles Mac audio" failure
    /// when AirPods/Blackshark are on the Mac and iPhone has nothing.
    @MainActor
    func applyHeadphoneRouting(services: ServiceContainer) async {
        let phoneHasPhones = services.avHost.hasHeadphonesAttached
        let phoneTakesOver = phoneHasPhones

        services.avHost.setMuted(!phoneTakesOver)
        try? await services.api.setMacMute(phoneTakesOver)

        await services.ui.toast(
            phoneTakesOver ? "Audio: phone (headphones)" : "Audio: Mac"
        )
    }
}
