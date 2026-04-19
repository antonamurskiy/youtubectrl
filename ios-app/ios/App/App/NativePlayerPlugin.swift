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
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPip", returnType: CAPPluginReturnPromise),
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
        CAPPluginMethod(name: "seekToDate", returnType: CAPPluginReturnPromise)
    ]

    private var player: AVPlayer?
    private var playerLayer: AVPlayerLayer?
    private var playerContainer: UIView?
    private var pipController: AVPictureInPictureController?
    private var timeObserver: Any?
    private var currentArtworkUrl: String?
    private var currentArtwork: MPMediaItemArtwork?
    private var remoteCommandsInstalled = false
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

    @objc func setLayerFrame(_ call: CAPPluginCall) {
        let x = call.getDouble("x") ?? 0
        let y = call.getDouble("y") ?? 0
        let w = call.getDouble("w") ?? 1
        let h = call.getDouble("h") ?? 1
        let visible = call.getBool("visible") ?? true
        DispatchQueue.main.async {
            self.ensureLayer()
            guard let container = self.playerContainer, let layer = self.playerLayer,
                  let wv = self.bridge?.webView else {
                call.resolve(["ok": false]); return
            }
            if visible {
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
            } else {
                container.frame = CGRect(x: -9999, y: -9999, width: 1, height: 1)
            }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.frame = container.bounds
            CATransaction.commit()
            call.resolve(["ok": true])
        }
    }

    private func installPipController() {
        guard let layer = playerLayer,
              AVPictureInPictureController.isPictureInPictureSupported() else { return }
        if pipController != nil { return }
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

        cmd.playCommand.isEnabled = true
        cmd.playCommand.addTarget { [weak self] _ in
            self?.player?.play()
            self?.notifyListeners("remotePlay", data: [:])
            self?.updateNowPlayingPlaybackState()
            return .success
        }

        cmd.pauseCommand.isEnabled = true
        cmd.pauseCommand.addTarget { [weak self] _ in
            self?.player?.pause()
            self?.notifyListeners("remotePause", data: [:])
            self?.updateNowPlayingPlaybackState()
            return .success
        }

        cmd.togglePlayPauseCommand.isEnabled = true
        cmd.togglePlayPauseCommand.addTarget { [weak self] _ in
            if let p = self?.player { if p.rate == 0 { p.play() } else { p.pause() } }
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

        // Two-stream mode: separate DASH video + audio URLs combined into
        // an AVMutableComposition so we can play 1080p + 128kbps AAC without
        // any ffmpeg remuxing.
        if let v = videoUrlStr, let a = audioUrlStr,
           let videoURL = URL(string: v), let audioURL = URL(string: a) {
            Task { @MainActor in
                do {
                    let item = try await self.buildCompositionItem(videoURL: videoURL, audioURL: audioURL)
                    self.ensureLayer()
                    if self.player == nil {
                        self.player = AVPlayer(playerItem: item)
                    } else {
                        self.player?.replaceCurrentItem(with: item)
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
    /// as one logical stream.
    @MainActor
    private func buildCompositionItem(videoURL: URL, audioURL: URL) async throws -> AVPlayerItem {
        let videoAsset = AVURLAsset(url: videoURL)
        let audioAsset = AVURLAsset(url: audioURL)

        let composition = AVMutableComposition()

        async let videoDuration: CMTime = videoAsset.load(.duration)
        async let audioDuration: CMTime = audioAsset.load(.duration)
        let (vd, ad) = try await (videoDuration, audioDuration)
        NSLog("[NativePlayer] composition video dur=\(vd.seconds) audio dur=\(ad.seconds)")
        let duration = CMTimeMinimum(vd, ad)

        let videoTracks = try await videoAsset.loadTracks(withMediaType: .video)
        let audioTracks = try await audioAsset.loadTracks(withMediaType: .audio)
        NSLog("[NativePlayer] loaded videoTracks=\(videoTracks.count) audioTracks=\(audioTracks.count)")

        if let videoTrack = videoTracks.first {
            let comp = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
            try comp?.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: videoTrack, at: .zero)
        }
        if let audioTrack = audioTracks.first {
            let comp = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
            try comp?.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: audioTrack, at: .zero)
        }

        return AVPlayerItem(asset: composition)
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player?.play()
            self.setIdleTimer(disabled: true)
            self.updateNowPlayingPlaybackState()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
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

            // Silent keep-alive. iOS's lock-screen Now Playing widget
            // infers play/pause partly from whether the app's audio session
            // is actively playing audio. Keeping the silent player at
            // rate=1 while mpv is paused makes the widget show the pause
            // icon (i.e. "playing") even though playbackState=.paused. So
            // mirror the reported paused state onto the silent player.
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
        notifyListeners("pipStopped", data: [:])
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
