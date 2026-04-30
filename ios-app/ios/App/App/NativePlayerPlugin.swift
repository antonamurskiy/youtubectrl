import Foundation
import Capacitor
import AVKit
import AVFoundation
import MediaPlayer
import UIKit
import ActivityKit

/**
 * Native video player + PiP + system integration for YouTubeCtrl.
 *
 * Responsibilities:
 *   - AVPlayer playback (hand-off from the web UI for true Picture-in-Picture)
 *   - MPNowPlayingInfoCenter metadata (lock screen / Control Center artwork)
 *   - MPRemoteCommandCenter (AirPods taps, lock-screen buttons, media keys)
 *   - AirPlay route picker (MPVolumeView's AirPlay button, presented over webview)
 *   - UIApplication.isIdleTimerDisabled while playing (screen never sleeps)
 *
 * Web JS calls methods on `NativePlayer` (registered below). Events are sent
 * back via `notifyListeners`.
 */
@objc(NativePlayerPlugin)
public class NativePlayerPlugin: CAPPlugin, CAPBridgedPlugin, AVPictureInPictureControllerDelegate {
    public let identifier = "NativePlayerPlugin"
    public let jsName = "NativePlayer"

    public override func load() {
        super.load()
        NSLog("[NativePlayer] plugin loaded v3")
        debugLog("plugin loaded v3")
        // Auto-stop PiP when the app returns to foreground — otherwise the
        // user sees the floating PiP window on top of the in-app player.
        // Listen on multiple lifecycle events since PiP auto-start from
        // inline doesn't always correspond with willEnterForeground.
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(onForeground),
                       name: UIApplication.willEnterForegroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(onForeground),
                       name: UIApplication.didBecomeActiveNotification, object: nil)
        // AppDelegate posts this when a kill-feed/prompt notification is
        // tapped. Forward the tmux-window index to JS so it opens the
        // terminal panel + (the server has already switched the pane).
        nc.addObserver(self, selector: #selector(onPushTap(_:)),
                       name: Notification.Name("YTCtrlPushTap"), object: nil)
    }

    @objc private func onPushTap(_ note: Notification) {
        let idx = (note.userInfo?["tmuxWindow"] as? Int) ?? -1
        let answer = (note.userInfo?["answer"] as? String) ?? ""
        self.notifyListeners("pushTap", data: ["tmuxWindow": idx, "answer": answer])
    }

    @objc private func onForeground() {
        DispatchQueue.main.async {
            // Auto-stop only for BACKGROUND-triggered PiP. If the user
            // explicitly started PiP while the app was in foreground
            // (via the in-app button), keep it running — the whole
            // point of foreground PiP is a floating mini-player next
            // to something else (e.g. browsing the feed while the
            // video stays up).
            if self.userStartedPip { return }
            if let ctrl = self.pipController, ctrl.isPictureInPictureActive {
                ctrl.stopPictureInPicture()
            }
        }
    }
    private var userStartedPip = false
    // Speaker-suppression state. During phone-only handoff from the
    // Mac, AirPods disconnect from the Mac and briefly the iPhone
    // routes audio through its built-in speaker before they re-connect
    // here. suppressUntilHeadphones() mutes AVPlayer and watches for a
    // route-change notification; once the current route is no longer
    // the built-in speaker (bluetooth/wired headphones/CarPlay), it
    // unmutes. Has a hard timeout so we never leave the user stuck on
    // mute if no headphones ever connect.
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPipSafeArea", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showAirPlayPicker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolumeIntercept", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startLiveActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateLiveActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endLiveActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLayerFrame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLiveState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seekToDate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingPushTap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSafeAreaBackground", returnType: CAPPluginReturnPromise)
    ]

    private var player: AVPlayer?
    private var playerLayer: AVPlayerLayer?
    private var playerContainer: UIView?
    private var pipController: AVPictureInPictureController?
    // Set when installPipController() declined to recreate because
    // PiP was active. The delegate's
    // pictureInPictureControllerDidStopPictureInPicture handler reads
    // this and triggers a deferred reinstall so auto-PiP re-engages
    // on the next background.
    private var pipReinstallPending: Bool = false
    private var timeObserver: Any?
    private var rateObserver: NSKeyValueObservation?
    private var currentArtworkUrl: String?
    private var currentArtwork: MPMediaItemArtwork?
    private var remoteCommandsInstalled = false
    // Tracks what we (the app) last told AVPlayer to do. When KVO fires
    // for a rate change and the new state matches `expectedPaused`, it
    // came from our own play/pause call — ignore it. Otherwise the user
    // flipped the state externally (PiP window's play/pause button,
    // AirPods control) and we emit an event so JS can sync mpv.
    private var expectedPaused: Bool = false
    private var hiddenRoutePicker: AVRoutePickerView?

    // Silent keep-alive player — runs in the background so the audio session
    // stays active and iOS shows Now Playing even when the actual audio is
    // coming from the desktop (mpv). Plays a silent looping track.
    private var silentPlayer: AVPlayer?
    private var silentLooper: Any?

    // Volume button interception — when enabled, phone hardware volume
    // buttons are converted into deltas that the web layer forwards to the
    // Mac via /api/volume-bump. We keep a hidden MPVolumeView anchored
    // offscreen so we can silently restore the phone's volume after each
    // button press — the phone's own volume should stay fixed at the
    // baseline while the app is controlling the Mac.
    private var volumeInterceptEnabled = false
    private let volumeBaseline: Float = 0.5
    private var lastObservedVolume: Float = 0.5
    private var hiddenVolumeView: MPVolumeView?
    private var volumeSlider: UISlider?
    private var volumeObserver: NSKeyValueObservation?
    private var lastRestoreRequestedAt = Date.distantPast

    // Live Activity (lock screen widget)
    private var liveActivity: Any? // Activity<YouTubeCtrlActivityAttributes> on iOS 16.1+

    private func ensureLayer() {
        guard playerLayer == nil, let wv = self.bridge?.webView else { return }
        // Transparent container added ABOVE the WKWebView so the AVPlayer's
        // video is visible to the user. isUserInteractionEnabled = false so
        // taps still pass through to the WebView (phone-player UI controls).
        // Starts at 1x1 offscreen; web layer calls setLayerFrame() with the
        // rect of its placeholder div to reposition.
        let container = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        container.isUserInteractionEnabled = false
        container.backgroundColor = .black
        wv.superview?.insertSubview(container, aboveSubview: wv)
        self.playerContainer = container

        let layer = AVPlayerLayer()
        layer.frame = container.bounds
        // resizeAspect shows black bars. resizeAspectFill fills but can crop
        // tall (vertical) videos. Use .resize (stretch) for the inline view
        // since our HTML <video> placeholder has aspect-ratio: 16/9 anyway.
        layer.videoGravity = .resizeAspectFill
        container.layer.addSublayer(layer)
        self.playerLayer = layer
    }

    // Cache of the last applied (x, y, w, h, visible) signature.
    // Short-circuits redundant work on the JS rAF tick — even with
    // a 30Hz JS-side throttle, identical frames arrive constantly
    // when the panel is stationary.
    private var lastSetLayerSig: String = ""
    @objc func setLayerFrame(_ call: CAPPluginCall) {
        let x = call.getDouble("x") ?? 0
        let y = call.getDouble("y") ?? 0
        let w = call.getDouble("w") ?? 1
        let h = call.getDouble("h") ?? 1
        let visible = call.getBool("visible") ?? true
        // Round to 1px precision and compare; identical frames skip
        // the main-queue dispatch entirely.
        let sig = "\(Int(x.rounded())),\(Int(y.rounded())),\(Int(w.rounded())),\(Int(h.rounded())),\(visible)"
        if sig == self.lastSetLayerSig {
            call.resolve(["ok": true]); return
        }
        self.lastSetLayerSig = sig
        DispatchQueue.main.async {
            self.ensureLayer()
            guard let container = self.playerContainer, let layer = self.playerLayer,
                  let wv = self.bridge?.webView else {
                call.resolve(["ok": false]); return
            }
            // Use isHidden, NOT off-screen frame. Moving the container to
            // (-9999, -9999) made iOS treat the AVPlayerLayer as no longer
            // in-view, which disabled
            // canStartPictureInPictureAutomaticallyFromInline. After flipping
            // back to visible, auto-PiP didn't re-register and the user had
            // to start PiP manually. isHidden keeps the layer registered with
            // the PiP system; auto-PiP fires correctly the next time the
            // app backgrounds.
            // While PiP is active, the AVPlayerLayer's content is
            // owned by the PiP window. Showing the inline container
            // makes iOS auto-stop PiP and reclaim the layer. Suppress
            // visible=true requests during active PiP so the user
            // sees PiP, not the inline mini-player, when toggling
            // sync mode while PiP is up.
            let pipActive = self.pipController?.isPictureInPictureActive == true
            let wantVisible = visible && !pipActive
            let wasHidden = container.isHidden
            container.isHidden = !wantVisible
            if wantVisible {
                // getBoundingClientRect returns coordinates in the WebView's
                // viewport. Convert to the parent view's coordinate space by
                // adding the WebView's origin.
                let wvOrigin = wv.frame.origin
                container.frame = CGRect(
                    x: wvOrigin.x + x,
                    y: wvOrigin.y + y,
                    width: max(1, w),
                    height: max(1, h)
                )
            }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.frame = container.bounds
            CATransaction.commit()
            // Mirror auto-PiP eligibility to inline visibility. In
            // computer mode the AVPlayer is intentionally left
            // playing-but-hidden (warm for fast re-engage of sync),
            // and the still-true canStartPictureInPictureAutomaticallyFromInline
            // would fire PiP on background showing the STALE item
            // because computer-mode video switches only update mpv,
            // not the AVPlayer. Disable when hidden, re-enable when
            // visible. Don't touch during active PiP — that'd kill
            // the live session.
            if !pipActive, #available(iOS 14.2, *), let ctrl = self.pipController {
                ctrl.canStartPictureInPictureAutomaticallyFromInline = wantVisible
                NSLog("[NativePlayer] auto-PiP enabled=\(wantVisible) (visibility=\(wantVisible ? "shown" : "hidden"))")
            } else {
                NSLog("[NativePlayer] auto-PiP unchanged (pipActive=\(pipActive) ctrl=\(self.pipController != nil))")
            }
            // Reinstall the PiP controller on hidden→visible transitions.
            // iOS treats canStartPictureInPictureAutomaticallyFromInline
            // as one-shot — after the layer was hidden, auto-PiP doesn't
            // re-engage on next background. Recreating fully re-registers
            // the layer. Defer one runloop turn so the layer's frame +
            // host visibility have actually committed before the new
            // controller captures them — without this, auto-PiP silently
            // refuses to fire on the next background and the user has to
            // tap the PiP button manually.
            if wasHidden && wantVisible {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                    self?.installPipController()
                }
            }
            call.resolve(["ok": true])
        }
    }

    private func installRateObserver() {
        guard let player = self.player else { return }
        self.rateObserver?.invalidate()
        self.rateObserver = player.observe(\.rate, options: [.old, .new]) { [weak self] p, change in
            guard let self = self else { return }
            let oldRate = change.oldValue ?? 0
            let newRate = change.newValue ?? 0
            let nowPaused = newRate == 0
            // Ignore transitions that just reflect what we requested —
            // those came from our own play()/pause() methods.
            if nowPaused == self.expectedPaused { return }
            // User toggled externally (PiP play/pause, AirPods, lock
            // screen) — update expected so we don't loop, and notify JS.
            self.expectedPaused = nowPaused
            self.notifyListeners("playerStateChanged", data: ["paused": nowPaused])
        }
    }

    private func installPipController() {
        guard let layer = playerLayer,
              AVPictureInPictureController.isPictureInPictureSupported() else { return }
        // Don't tear down a controller that's currently driving an
        // active PiP session — that kills the live PiP. Defer the
        // reinstall to when PiP ends (delegate hook) so auto-PiP
        // still re-registers on the layer-was-hidden path.
        if let existing = pipController, existing.isPictureInPictureActive {
            pipReinstallPending = true
            return
        }
        pipReinstallPending = false
        // Reinstall on each call. iOS empirically treats
        // canStartPictureInPictureAutomaticallyFromInline as
        // one-shot per controller lifecycle — after the layer was
        // hidden and reshown, the existing controller won't auto-PiP
        // on next background. Recreating fully re-registers the layer.
        pipController?.delegate = nil
        pipController = nil
        let ctrl = AVPictureInPictureController(playerLayer: layer)
        ctrl?.delegate = self
        if #available(iOS 14.2, *) {
            ctrl?.canStartPictureInPictureAutomaticallyFromInline = true
        }
        self.pipController = ctrl
    }

    private func installRemoteCommands() {
        if remoteCommandsInstalled { return }
        remoteCommandsInstalled = true

        let cmd = MPRemoteCommandCenter.shared()

        // Set expectedPaused BEFORE mutating player.rate so the rate KVO
        // observer recognizes the change as expected and skips emitting
        // `playerStateChanged`. Without this, both remote* and
        // playerStateChanged events fire for the same tap, and JS POSTs
        // /api/playpause twice — net zero, so the lock-widget play button
        // appears to do nothing.
        cmd.playCommand.isEnabled = true
        cmd.playCommand.addTarget { [weak self] _ in
            self?.expectedPaused = false
            self?.player?.play()
            self?.notifyListeners("remotePlay", data: [:])
            self?.updateNowPlayingPlaybackState()
            return .success
        }

        cmd.pauseCommand.isEnabled = true
        cmd.pauseCommand.addTarget { [weak self] _ in
            self?.expectedPaused = true
            self?.player?.pause()
            self?.notifyListeners("remotePause", data: [:])
            self?.updateNowPlayingPlaybackState()
            return .success
        }

        cmd.togglePlayPauseCommand.isEnabled = true
        cmd.togglePlayPauseCommand.addTarget { [weak self] _ in
            if let p = self?.player {
                if p.rate == 0 { self?.expectedPaused = false; p.play() }
                else { self?.expectedPaused = true; p.pause() }
            }
            self?.notifyListeners("remoteTogglePlayPause", data: [:])
            self?.updateNowPlayingPlaybackState()
            return .success
        }

        cmd.skipForwardCommand.preferredIntervals = [10]
        cmd.skipForwardCommand.isEnabled = true
        cmd.skipForwardCommand.addTarget { [weak self] _ in
            if let p = self?.player {
                let now = p.currentTime().seconds
                p.seek(to: CMTime(seconds: now + 10, preferredTimescale: 600))
            }
            self?.notifyListeners("remoteSkip", data: ["delta": 10])
            return .success
        }

        cmd.skipBackwardCommand.preferredIntervals = [10]
        cmd.skipBackwardCommand.isEnabled = true
        cmd.skipBackwardCommand.addTarget { [weak self] _ in
            if let p = self?.player {
                let now = p.currentTime().seconds
                p.seek(to: CMTime(seconds: max(0, now - 10), preferredTimescale: 600))
            }
            self?.notifyListeners("remoteSkip", data: ["delta": -10])
            return .success
        }

        cmd.changePlaybackPositionCommand.isEnabled = true
        cmd.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let positionEvent = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.player?.seek(to: CMTime(seconds: positionEvent.positionTime, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            self?.notifyListeners("remoteSeek", data: ["position": positionEvent.positionTime])
            return .success
        }
    }

    private func debugLog(_ msg: String) {
        NSLog("[NativePlayer] \(msg)")
    }

    /// Starts a silent looping audio track so the audio session stays active
    /// and iOS shows the Now Playing widget even when local AVPlayer isn't
    /// playing anything (e.g. audio is actually coming from desktop mpv).
    ///
    /// The file itself must be truly silent audio (not volume 0) — iOS suspends
    /// the audio session if it detects silence via the mixer.
    private func startSilentAudioIfNeeded() {
        // Make sure the audio session is active and configured for playback.
        // Other apps (or iOS) may have deactivated it since app launch.
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playback, mode: .moviePlayback, options: [.allowAirPlay]
            )
            try AVAudioSession.sharedInstance().setActive(true)
            debugLog("audio session active")
        } catch {
            debugLog("audio session activate failed: \(error)")
        }

        if silentPlayer != nil {
            silentPlayer?.play()
            debugLog("silent player resumed")
            return
        }
        guard let url = URL(string: "http://yuzu.local:3000/silent.m4a") else { return }
        let item = AVPlayerItem(url: url)
        let p = AVQueuePlayer(playerItem: item)
        p.actionAtItemEnd = .none
        if #available(iOS 10.0, *) {
            silentLooper = AVPlayerLooper(player: p, templateItem: item)
        }
        p.volume = 1.0
        p.play()
        silentPlayer = p
        debugLog("silent player started, rate=\(p.rate) volume=\(p.volume)")

        // Check back in 1s to see if it's actually playing
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self = self, let p = self.silentPlayer else { return }
            let err = p.currentItem?.error?.localizedDescription ?? "nil"
            self.debugLog("silent player 1s check: rate=\(p.rate) status=\(p.currentItem?.status.rawValue ?? -1) err=\(err)")
        }
    }

    private func updateNowPlayingPlaybackState() {
        guard let p = player else { return }
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = p.currentTime().seconds
        info[MPNowPlayingInfoPropertyPlaybackRate] = p.rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        if #available(iOS 13.0, *) {
            MPNowPlayingInfoCenter.default().playbackState = p.rate == 0 ? .paused : .playing
        }
    }

    private func setIdleTimer(disabled: Bool) {
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = disabled
        }
    }

    // MARK: - Bridged methods

    @objc func load(_ call: CAPPluginCall) {
        let urlStr = call.getString("url")
        let videoUrlStr = call.getString("videoUrl")
        let audioUrlStr = call.getString("audioUrl")
        let position = call.getDouble("position") ?? 0
        let autoplay = call.getBool("autoplay") ?? true
        let muted = call.getBool("muted") ?? false
        // Server-provided authoritative duration (seconds). When present,
        // the composition is clamped to this value — YouTube DASH URLs
        // sometimes report 2× the real duration via AVURLAsset (seen on
        // post_live recordings), which then propagates through the UI
        // scrubber and break phone-only progress reporting.
        let durationHint = call.getDouble("durationSec") ?? 0

        // Two-stream mode: separate DASH video + audio URLs combined into
        // an AVMutableComposition so we can play 1080p + 128kbps AAC without
        // any ffmpeg remuxing.
        if let v = videoUrlStr, let a = audioUrlStr,
           let videoURL = URL(string: v), let audioURL = URL(string: a) {
            Task { @MainActor in
                do {
                    let item = try await self.buildCompositionItem(videoURL: videoURL, audioURL: audioURL, durationHint: durationHint)
                    self.ensureLayer()
                    if self.player == nil {
                        self.player = AVPlayer(playerItem: item)
                        self.installRateObserver()
                    } else {
                        // PiP-friendly swap. replaceCurrentItem on a
                        // playing AVPlayer while PiP is active can leave
                        // the PiP window stuck on the old item's last
                        // frame. Pause → swap → resume avoids that.
                        let wasPlaying = (self.player?.rate ?? 0) > 0
                        self.player?.pause()
                        self.player?.replaceCurrentItem(with: item)
                        if wasPlaying || autoplay {
                            self.player?.play()
                        }
                    }
                    self.playerLayer?.player = self.player
                    if position > 0 {
                        await self.player?.seek(to: CMTime(seconds: position, preferredTimescale: 600))
                    }
                    self.player?.isMuted = muted
                    self.player?.volume = muted ? 0.0 : 1.0
                    self.installPipController()
                    self.installRemoteCommands()
                    if autoplay {
                        self.player?.play()
                        self.setIdleTimer(disabled: true)
                    }
                    self.notifyListeners("loaded", data: ["url": v])
                    call.resolve()
                } catch {
                    call.reject("composition failed: \(error.localizedDescription)")
                }
            }
            return
        }

        // Single-URL mode (progressive MP4 or HLS)
        guard let urlStr = urlStr, let url = URL(string: urlStr) else {
            call.reject("url or videoUrl+audioUrl required")
            return
        }
        DispatchQueue.main.async {
            self.ensureLayer()
            let item = AVPlayerItem(url: url)
            // Don't pin the item to a live-offset target — when we seek to
            // an arbitrary Date (for sync with mpv), AVPlayer otherwise
            // drifts back toward N-seconds-behind-live after the seek,
            // fighting the drift loop and producing persistent residual.
            if #available(iOS 13.0, *) {
                item.automaticallyPreservesTimeOffsetFromLive = false
            }
            if self.player == nil {
                self.player = AVPlayer(playerItem: item)
                self.installRateObserver()
            } else {
                self.player?.replaceCurrentItem(with: item)
            }
            self.playerLayer?.player = self.player
            if position > 0 {
                self.player?.seek(to: CMTime(seconds: position, preferredTimescale: 600))
            }
            self.player?.isMuted = muted
            self.player?.volume = muted ? 0.0 : 1.0
            self.installPipController()
            self.installRemoteCommands()
            if autoplay {
                self.player?.play()
                self.setIdleTimer(disabled: true)
            }
            self.notifyListeners("loaded", data: ["url": urlStr])
            call.resolve()
        }
    }

    /// Build an AVPlayerItem that plays a separate video track and audio track
    /// as one logical stream. Defensive against half-loaded assets — YouTube's
    /// per-track googlevideo URLs occasionally return invalid/zero durations
    /// on first HTTP probe, which then hits an assertion inside
    /// insertTimeRange and kills the app. We validate before inserting.
    @MainActor
    private func buildCompositionItem(videoURL: URL, audioURL: URL, durationHint: Double = 0) async throws -> AVPlayerItem {
        let assetOpts: [String: Any] = [
            AVURLAssetPreferPreciseDurationAndTimingKey: true,
        ]
        let videoAsset = AVURLAsset(url: videoURL, options: assetOpts)
        let audioAsset = AVURLAsset(url: audioURL, options: assetOpts)

        let composition = AVMutableComposition()

        // Kick off ALL four loads concurrently — both durations AND
        // both track lists. Was: durations awaited first, then track
        // loads serial. Each load is an HTTP probe RTT; doing them
        // in parallel cuts startup by 1-2 RTTs on the DASH path.
        async let videoDuration: CMTime = videoAsset.load(.duration)
        async let audioDuration: CMTime = audioAsset.load(.duration)
        async let videoTracksAsync = videoAsset.loadTracks(withMediaType: .video)
        async let audioTracksAsync = audioAsset.loadTracks(withMediaType: .audio)
        let (vd, ad) = try await (videoDuration, audioDuration)
        NSLog("[NativePlayer] composition video dur=\(vd.seconds) audio dur=\(ad.seconds) hint=\(durationHint)")

        func durationUsable(_ t: CMTime) -> Bool {
            return t.isValid && !t.isIndefinite && !t.isNegativeInfinity && !t.isPositiveInfinity && t.seconds.isFinite && t.seconds > 0
        }
        guard durationUsable(vd), durationUsable(ad) else {
            throw NSError(domain: "NativePlayer", code: -10, userInfo: [NSLocalizedDescriptionKey: "unusable duration: video=\(vd.seconds) audio=\(ad.seconds)"])
        }
        // Clamp to the server-supplied hint when present (accommodates
        // YouTube DASH URLs that report 2× real duration via AVURLAsset).
        // Use the minimum of hint / vd / ad — avoids reading past the
        // real media and avoids over-clamping if the hint is stale.
        var duration = CMTimeMinimum(vd, ad)
        if durationHint > 0 {
            let hint = CMTime(seconds: durationHint, preferredTimescale: 600)
            duration = CMTimeMinimum(duration, hint)
        }
        let range = CMTimeRange(start: .zero, duration: duration)

        let videoTracks = try await videoTracksAsync
        let audioTracks = try await audioTracksAsync
        NSLog("[NativePlayer] loaded videoTracks=\(videoTracks.count) audioTracks=\(audioTracks.count)")
        guard let videoTrack = videoTracks.first, let audioTrack = audioTracks.first else {
            throw NSError(domain: "NativePlayer", code: -11, userInfo: [NSLocalizedDescriptionKey: "missing tracks: video=\(videoTracks.count) audio=\(audioTracks.count)"])
        }

        guard let compV = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw NSError(domain: "NativePlayer", code: -12, userInfo: [NSLocalizedDescriptionKey: "failed to add video track"])
        }
        try compV.insertTimeRange(range, of: videoTrack, at: .zero)
        guard let compA = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw NSError(domain: "NativePlayer", code: -13, userInfo: [NSLocalizedDescriptionKey: "failed to add audio track"])
        }
        try compA.insertTimeRange(range, of: audioTrack, at: .zero)

        return AVPlayerItem(asset: composition)
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.expectedPaused = false
            self.player?.play()
            self.setIdleTimer(disabled: true)
            self.updateNowPlayingPlaybackState()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.expectedPaused = true
            self.player?.pause()
            self.setIdleTimer(disabled: false)
            self.updateNowPlayingPlaybackState()
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pipController?.stopPictureInPicture()
            self.player?.pause()
            self.player?.replaceCurrentItem(with: nil)
            // Tear down fully so the video layer and audio session go away
            self.playerLayer?.player = nil
            self.playerContainer?.removeFromSuperview()
            self.playerContainer = nil
            self.playerLayer = nil
            self.pipController = nil
            self.player = nil
            self.setIdleTimer(disabled: false)
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .stopped
            }
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        guard let position = call.getDouble("position") else {
            call.reject("position required")
            return
        }
        DispatchQueue.main.async {
            // Composition items require zero tolerances and waiting for the
            // current seek to complete before issuing the next one — otherwise
            // AVPlayer silently drops the request.
            let time = CMTime(seconds: position, preferredTimescale: 600)
            self.player?.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { _ in }
            self.updateNowPlayingPlaybackState()
            call.resolve()
        }
    }

    @objc func setRate(_ call: CAPPluginCall) {
        guard let rate = call.getFloat("rate") else {
            call.reject("rate required")
            return
        }
        DispatchQueue.main.async {
            self.player?.rate = rate
            call.resolve()
        }
    }

    @objc func startPip(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let ctrl = self.pipController else { call.reject("pip not ready"); return }
            if ctrl.isPictureInPicturePossible {
                self.userStartedPip = true
                ctrl.startPictureInPicture()
                call.resolve()
            } else {
                call.reject("pip not possible yet — try after playback starts")
            }
        }
    }

    @objc func stopPip(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.userStartedPip = false
            self.pipController?.stopPictureInPicture()
            call.resolve()
        }
    }

    // Previously attempted to reserve a bottom safe area for PiP via
    // additionalSafeAreaInsets. That also pushed the WebView's own
    // content upward (double-padding the NPB). Left as a no-op so
    // existing client callers don't error.
    @objc func setPipSafeArea(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let time = self.player?.currentTime().seconds ?? 0
            let duration = self.player?.currentItem?.duration.seconds ?? 0
            let rate = self.player?.rate ?? 0
            call.resolve([
                "position": time.isFinite ? time : 0,
                "duration": duration.isFinite ? duration : 0,
                "rate": rate,
                "paused": rate == 0
            ])
        }
    }

    /// Returns PDT (PROGRAM-DATE-TIME) information for HLS live playback.
    /// `currentDateMs` is the wall-clock of the frame currently on screen;
    /// `liveEdgeMs` is the wall-clock of the newest available segment.
    /// Both are NSNull when the stream has no PDT metadata (non-live, or
    /// pre-roll before the first frame has a date).
    @objc func getLiveState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let player = self.player
            let item = player?.currentItem
            let position = player?.currentTime().seconds ?? 0
            let duration = item?.duration.seconds ?? 0
            let rate = player?.rate ?? 0
            let currentDate = item?.currentDate()
            var liveEdgeMs: Any = NSNull()
            if let item = item, let cur = currentDate,
               let lastRange = item.seekableTimeRanges.last?.timeRangeValue {
                let liveEdgeTime = CMTimeAdd(lastRange.start, lastRange.duration).seconds
                let curTime = item.currentTime().seconds
                if liveEdgeTime.isFinite && curTime.isFinite {
                    liveEdgeMs = cur.timeIntervalSince1970 * 1000 + (liveEdgeTime - curTime) * 1000
                }
            }
            let currentDateMs: Any = currentDate.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull()
            call.resolve([
                "currentDateMs": currentDateMs,
                "liveEdgeMs": liveEdgeMs,
                "position": position.isFinite ? position : 0,
                "duration": duration.isFinite ? duration : 0,
                "rate": rate,
                "paused": rate == 0
            ])
        }
    }

    /// Seek the current HLS item to a specific wall-clock PDT. AVPlayerItem's
    /// date-based seek is frame-accurate for HLS streams with PDT tags —
    /// exactly what we need for cross-player sync with mpv.
    @objc func seekToDate(_ call: CAPPluginCall) {
        guard let epochMs = call.getDouble("epochMs") else {
            call.reject("epochMs required"); return
        }
        let date = Date(timeIntervalSince1970: epochMs / 1000)
        DispatchQueue.main.async {
            guard let item = self.player?.currentItem else {
                call.resolve(["ok": false, "reason": "no item"]); return
            }
            let ok = item.seek(to: date) { finished in
                call.resolve(["ok": finished])
            }
            if !ok {
                // Stream lacks PDT metadata; nothing to seek against.
                call.resolve(["ok": false, "reason": "no PDT"])
            }
        }
    }

    /// Paint the iOS safe-area regions (Dynamic Island gutter, home
    /// indicator) by swapping background colors on every layer that
    /// can show through. Capacitor StatusBar's setBackgroundColor is
    /// an Android-only no-op, and `body` bg alone doesn't reach the
    /// status-bar UIView area. Pass null/empty to revert.
    @objc func setSafeAreaBackground(_ call: CAPPluginCall) {
        let hex = call.getString("color") ?? ""
        DispatchQueue.main.async {
            let color = NativePlayerPlugin.colorFromHex(hex) ?? UIColor(red: 33.0/255, green: 33.0/255, blue: 33.0/255, alpha: 1)
            guard let webView = self.bridge?.webView else { return }
            webView.backgroundColor = color
            webView.scrollView.backgroundColor = color
            webView.isOpaque = false
            webView.superview?.backgroundColor = color
            webView.window?.backgroundColor = color
            // Walk up parents (UIViewController.view, UIWindow) and
            // also paint EVERY direct child of the window — Capacitor's
            // iOS status-bar plugin (when overlaysWebView=false) inserts
            // a tinted UIView at the top of the window stack that
            // covers our WebView's tinted bg. Recoloring all window
            // children catches it without us having to identify it
            // by name.
            var v: UIView? = webView
            while v != nil {
                v?.backgroundColor = color
                v = v?.superview
            }
            if let window = webView.window {
                for sub in window.subviews {
                    sub.backgroundColor = color
                }
            }
        }
        call.resolve(["ok": true])
    }

    private static func colorFromHex(_ hex: String) -> UIColor? {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s = String(s.dropFirst()) }
        guard s.count == 6 || s.count == 8 else { return nil }
        var v: UInt64 = 0
        guard Scanner(string: s).scanHexInt64(&v) else { return nil }
        let r, g, b, a: CGFloat
        if s.count == 6 {
            r = CGFloat((v >> 16) & 0xFF) / 255
            g = CGFloat((v >> 8) & 0xFF) / 255
            b = CGFloat(v & 0xFF) / 255
            a = 1
        } else {
            r = CGFloat((v >> 24) & 0xFF) / 255
            g = CGFloat((v >> 16) & 0xFF) / 255
            b = CGFloat((v >> 8) & 0xFF) / 255
            a = CGFloat(v & 0xFF) / 255
        }
        return UIColor(red: r, green: g, blue: b, alpha: a)
    }

    /// Returns and CLEARS any pending push-tap action stashed by
    /// AppDelegate when the user tapped a notification before the
    /// WebView was ready to receive the live `pushTap` event.
    /// Called by JS once on app foreground.
    @objc func getPendingPushTap(_ call: CAPPluginCall) {
        let idx = AppDelegate.pendingTmuxFocusIndex
        let answer = AppDelegate.pendingAnswer
        let dbg = AppDelegate.pendingDebugAction
        AppDelegate.pendingTmuxFocusIndex = nil
        AppDelegate.pendingAnswer = nil
        AppDelegate.pendingDebugAction = nil
        call.resolve([
            "tmuxWindow": idx ?? -1,
            "answer": answer ?? "",
            "debug": dbg ?? ""
        ])
    }

    @objc func setNowPlaying(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let artist = call.getString("artist") ?? ""
        let artworkUrl = call.getString("artworkUrl")
        let duration = call.getDouble("duration") ?? 0
        let position = call.getDouble("position") ?? 0
        let isLive = call.getBool("isLive") ?? false
        let paused = call.getBool("paused") ?? false

        DispatchQueue.main.async {
            var diag: [String: Any] = ["entered": true, "title": title, "paused": paused]
            self.debugLog("setNowPlaying title=\(title) paused=\(paused)")

            // Audio session setup with captured error
            do {
                try AVAudioSession.sharedInstance().setCategory(
                    .playback, mode: .moviePlayback, options: [.allowAirPlay]
                )
                try AVAudioSession.sharedInstance().setActive(true)
                diag["audioSessionOk"] = true
                diag["audioSessionCategory"] = AVAudioSession.sharedInstance().category.rawValue
            } catch {
                diag["audioSessionOk"] = false
                diag["audioSessionError"] = "\(error)"
            }

            // Silent keep-alive. Mirror mpv's paused state so the widget
            // shows the right play/pause icon — silent at rate=1 makes
            // iOS display the pause button (i.e. "content is playing")
            // regardless of what MPNowPlayingInfoCenter.playbackState
            // says. We accept that when paused the session may get
            // deactivated; the resume-from-CC fetch below uses
            // keepalive so it still reaches the server.
            if self.silentPlayer == nil {
                if let url = URL(string: "http://yuzu.local:3000/silent.m4a") {
                    let item = AVPlayerItem(url: url)
                    let p = AVQueuePlayer(playerItem: item)
                    p.actionAtItemEnd = .none
                    if #available(iOS 10.0, *) {
                        self.silentLooper = AVPlayerLooper(player: p, templateItem: item)
                    }
                    p.volume = 1.0
                    if paused { p.pause() } else { p.play() }
                    self.silentPlayer = p
                    diag["silentPlayerStarted"] = true
                } else {
                    diag["silentPlayerStarted"] = false
                }
            } else {
                if paused {
                    self.silentPlayer?.pause()
                    diag["silentPlayerPaused"] = true
                } else {
                    self.silentPlayer?.play()
                    diag["silentPlayerResumed"] = true
                }
            }
            diag["silentPlayerRate"] = self.silentPlayer?.rate ?? -1

            // Remote commands
            self.installRemoteCommands()
            diag["remoteCommandsInstalled"] = self.remoteCommandsInstalled

            // Reflect play/pause state on the widget
            let rate: Float = paused ? 0.0 : (self.player?.rate ?? 1.0)

            var info: [String: Any] = [
                MPMediaItemPropertyTitle: title,
                MPMediaItemPropertyArtist: artist,
                MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
                MPNowPlayingInfoPropertyPlaybackRate: rate,
                MPNowPlayingInfoPropertyIsLiveStream: isLive
            ]
            if duration > 0 && !isLive {
                info[MPMediaItemPropertyPlaybackDuration] = duration
            }
            if let existing = self.currentArtwork,
               artworkUrl == self.currentArtworkUrl {
                info[MPMediaItemPropertyArtwork] = existing
            }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            // On iOS 13+, the lock-screen widget uses playbackState as the
            // authoritative play/pause indicator. Setting only the rate in
            // nowPlayingInfo leaves the widget stuck on its previous state.
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = paused ? .paused : .playing
            }
            diag["infoSet"] = true
            call.resolve(diag)

            // Fetch and set artwork out of band — don't block on network
            if let urlStr = artworkUrl,
               urlStr != self.currentArtworkUrl,
               let url = URL(string: urlStr) {
                self.currentArtworkUrl = urlStr
                URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
                    guard let self = self, let data = data, let image = UIImage(data: data) else { return }
                    let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                    DispatchQueue.main.async {
                        // Check the URL hasn't changed while we were fetching
                        guard self.currentArtworkUrl == urlStr else { return }
                        self.currentArtwork = artwork
                        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                        info[MPMediaItemPropertyArtwork] = artwork
                        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                    }
                }.resume()
            }
        }
    }

    @objc func clearNowPlaying(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .stopped
            }
            self.currentArtwork = nil
            self.currentArtworkUrl = nil
            // Stop silent keep-alive track so iOS releases the audio session
            self.silentPlayer?.pause()
            self.silentPlayer = nil
            self.silentLooper = nil
            call.resolve()
        }
    }

    @objc func showAirPlayPicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let wv = self.bridge?.webView else { call.reject("no webview"); return }
            if self.hiddenRoutePicker == nil {
                let picker = AVRoutePickerView(frame: CGRect(x: -100, y: -100, width: 50, height: 50))
                picker.isHidden = true
                wv.superview?.addSubview(picker)
                self.hiddenRoutePicker = picker
            }
            // Programmatically tap the route picker button to open the native sheet.
            if let button = self.hiddenRoutePicker?.subviews.first(where: { $0 is UIButton }) as? UIButton {
                button.sendActions(for: .touchUpInside)
            }
            call.resolve()
        }
    }

    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        self.setIdleTimer(disabled: enabled)
        call.resolve()
    }

    /// Enable or disable hardware-volume-button interception.
    /// When enabled: phone volume buttons are silently reverted and a
    /// "volumeDelta" event is emitted to the JS side instead.
    @objc func setVolumeIntercept(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            if enabled {
                self.enableVolumeIntercept()
            } else {
                self.disableVolumeIntercept()
            }
            call.resolve()
        }
    }

    private func enableVolumeIntercept() {
        if volumeInterceptEnabled { return }
        volumeInterceptEnabled = true
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {}
        // Hidden MPVolumeView suppresses the system HUD when we change
        // volume via its slider.
        if hiddenVolumeView == nil, let wv = self.bridge?.webView {
            let v = MPVolumeView(frame: CGRect(x: -1000, y: -1000, width: 1, height: 1))
            v.alpha = 0.01
            v.isUserInteractionEnabled = false
            wv.superview?.addSubview(v)
            hiddenVolumeView = v
            for sub in v.subviews {
                if let s = sub as? UISlider { volumeSlider = s; break }
            }
        }
        // Snap phone volume to baseline on enable so delta computation is
        // stable from the first press.
        restoreVolume(to: volumeBaseline)
        volumeObserver = AVAudioSession.sharedInstance().observe(\.outputVolume, options: [.new]) { [weak self] _, change in
            guard let self = self else { return }
            if !self.volumeInterceptEnabled { return }
            guard let newValue = change.newValue else { return }

            // Swallow our own restore echoes: an observation that lands
            // back at baseline within a short window after we asked for a
            // restore is our slider change, not a user press. Using both
            // the target-value match AND the time window narrows the race
            // to the (rare) case where a physical press happens to land on
            // baseline within ~80ms of our restore.
            let sinceRestore = Date().timeIntervalSince(self.lastRestoreRequestedAt)
            if sinceRestore < 0.08 && abs(newValue - self.volumeBaseline) < 0.01 {
                self.lastObservedVolume = newValue
                return
            }

            let delta = newValue - self.lastObservedVolume
            self.lastObservedVolume = newValue
            if abs(delta) < 0.005 { return }

            let bump = delta > 0 ? 3 : -3
            self.notifyListeners("volumeButton", data: ["delta": bump])

            // Recentre after every press so the phone's own volume stays
            // fixed while the app is controlling the Mac.
            self.restoreVolume(to: self.volumeBaseline)
        }
    }

    private func disableVolumeIntercept() {
        volumeInterceptEnabled = false
        volumeObserver?.invalidate()
        volumeObserver = nil
        hiddenVolumeView?.removeFromSuperview()
        hiddenVolumeView = nil
        volumeSlider = nil
    }

    private func restoreVolume(to value: Float) {
        lastRestoreRequestedAt = Date()
        lastObservedVolume = value
        if let slider = volumeSlider {
            slider.setValue(value, animated: false)
            slider.sendActions(for: .valueChanged)
        } else {
            MPVolumeView.setVolume(value)
        }
    }

    // MARK: - Live Activity

    @objc func startLiveActivity(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.resolve(["ok": false, "reason": "iOS 16.1+ required"]); return }
        if !ActivityAuthorizationInfo().areActivitiesEnabled {
            call.resolve(["ok": false, "reason": "Activities disabled in Settings"])
            return
        }
        let title = call.getString("title") ?? ""
        let channel = call.getString("channel") ?? ""
        let artworkUrl = call.getString("artworkUrl") ?? ""
        let volume = call.getInt("volume") ?? 50
        let paused = call.getBool("paused") ?? false
        let position = call.getDouble("position") ?? 0
        let duration = call.getDouble("duration") ?? 0
        let isLive = call.getBool("isLive") ?? false

        // End any existing activity first
        endLiveActivityInternal()

        let state = YouTubeCtrlActivityAttributes.ContentState(
            title: title, channel: channel, artworkUrl: artworkUrl,
            volume: volume, paused: paused, position: position,
            duration: duration, isLive: isLive
        )
        let attributes = YouTubeCtrlActivityAttributes()
        do {
            let act = try Activity<YouTubeCtrlActivityAttributes>.request(
                attributes: attributes,
                content: .init(state: state, staleDate: nil),
                pushType: nil
            )
            self.liveActivity = act
            call.resolve(["ok": true, "id": act.id])
        } catch {
            call.resolve(["ok": false, "reason": "\(error)"])
        }
    }

    @objc func updateLiveActivity(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.resolve(["ok": false]); return }
        guard let act = self.liveActivity as? Activity<YouTubeCtrlActivityAttributes> else {
            call.resolve(["ok": false, "reason": "no active activity"]); return
        }
        let title = call.getString("title") ?? act.content.state.title
        let channel = call.getString("channel") ?? act.content.state.channel
        let artworkUrl = call.getString("artworkUrl") ?? act.content.state.artworkUrl
        let volume = call.getInt("volume") ?? act.content.state.volume
        let paused = call.getBool("paused") ?? act.content.state.paused
        let position = call.getDouble("position") ?? act.content.state.position
        let duration = call.getDouble("duration") ?? act.content.state.duration
        let isLive = call.getBool("isLive") ?? act.content.state.isLive

        let state = YouTubeCtrlActivityAttributes.ContentState(
            title: title, channel: channel, artworkUrl: artworkUrl,
            volume: volume, paused: paused, position: position,
            duration: duration, isLive: isLive
        )
        Task {
            await act.update(.init(state: state, staleDate: nil))
            call.resolve(["ok": true])
        }
    }

    @objc func endLiveActivity(_ call: CAPPluginCall) {
        endLiveActivityInternal()
        call.resolve()
    }

    private func endLiveActivityInternal() {
        guard #available(iOS 16.2, *) else { return }
        if let act = self.liveActivity as? Activity<YouTubeCtrlActivityAttributes> {
            Task { await act.end(nil, dismissalPolicy: .immediate) }
            self.liveActivity = nil
        }
    }

    // MARK: - PiP delegate

    public func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
        notifyListeners("pipStarted", data: [:])
    }
    public func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
        // Clear the user-started flag so the next auto-on-background
        // PiP is still killed by onForeground.
        self.userStartedPip = false
        notifyListeners("pipStopped", data: [:])
        // Honor a deferred reinstall request that came in while PiP
        // was active. Without this, auto-PiP wouldn't re-engage on
        // the next background after a sync→computer→sync flip that
        // happened during an active PiP session.
        if self.pipReinstallPending {
            self.pipReinstallPending = false
            DispatchQueue.main.async { [weak self] in self?.installPipController() }
        }
    }
}

// Extension fallback for setting volume without an MPVolumeView slider.
// (Preferred path is setting slider.value; this is the backup.)
extension MPVolumeView {
    static func setVolume(_ volume: Float) {
        let v = MPVolumeView()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) {
            if let slider = v.subviews.compactMap({ $0 as? UISlider }).first {
                slider.value = volume
            }
        }
    }
}
