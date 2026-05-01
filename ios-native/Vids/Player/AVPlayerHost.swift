import Foundation
import AVKit
import AVFoundation
import UIKit
import MediaPlayer
import Combine
import Observation

/// Phase 5 — full port of the essentials from
/// `ios-app/ios/App/App/NativePlayerPlugin.swift`. Each method's
/// invariants (PiP-friendly swap, automaticallyPreservesTimeOffsetFromLive=false,
/// MPRemoteCommandCenter wiring, hardware-volume KVO) are documented
/// inline. Subclass / extend rather than rewrite — the existing rules
/// took multiple iterations to get right.
/// UIView whose backing layer IS the AVPlayerLayer (set via
/// layerClass). Auto-sizes the player layer with the view — no manual
/// frame sync, no sublayer dance.
final class PlayerHostView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    init(player: AVPlayer) {
        super.init(frame: .zero)
        backgroundColor = .black
        playerLayer.player = player
        playerLayer.videoGravity = .resizeAspect
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError() }
}

/// All UI-touching methods are explicitly @MainActor; class itself is
/// not isolated so it can be instantiated from ServiceContainer init.
@Observable
final class AVPlayerHost: NSObject {
    static let shared = AVPlayerHost()

    let player: AVPlayer = {
        let p = AVPlayer()
        p.allowsExternalPlayback = true
        p.actionAtItemEnd = .pause
        return p
    }()

    /// UIView holding the AVPlayerLayer. Custom subclass so the layer
    /// auto-resizes with the view (default UIView's backing layer is a
    /// CALayer, not AVPlayerLayer, and adding the layer as a sublayer
    /// requires manual frame sync on every layout pass).
    let containerView: PlayerHostView

    private var playerLayer: AVPlayerLayer { containerView.playerLayer }
    private var pip: AVPictureInPictureController?
    private var rateObserver: NSKeyValueObservation?
    private var statusObserver: NSKeyValueObservation?
    private var volumeObserver: NSKeyValueObservation?
    private var routePicker: AVRoutePickerView?
    private var nowPlayingArtwork: UIImage?
    private var lastVolume: Float = 0.5
    private var lastRestoreAt: Date?

    var isMuted: Bool = false
    var volumeInterceptEnabled: Bool = false
    var onVolumeButton: ((Int) -> Void)?
    var onRemotePlayPause: (() -> Void)?
    var onRemoteSkip: ((Double) -> Void)?
    var onRemoteSeek: ((Double) -> Void)?

    override init() {
        containerView = PlayerHostView(player: player)
        super.init()
        configureAudioSession()
        installRateObserver()
        installPipController()
        installRemoteCommands()
    }

    // MARK: - Load

    /// Single-URL path (progressive MP4 / HLS).
    func load(url: URL, position: Double = 0, autoplay: Bool = true, muted: Bool = false) {
        let item = AVPlayerItem(url: url)
        item.automaticallyPreservesTimeOffsetFromLive = false
        applyItem(item, position: position, autoplay: autoplay, muted: muted)
    }

    /// Two-stream DASH path: separate video + audio URLs combined into
    /// an AVMutableComposition. Used for 1080p + AAC playback without
    /// ffmpeg remuxing.
    func loadDASH(videoURL: URL, audioURL: URL, durationHint: Double = 0,
                  position: Double = 0, autoplay: Bool = true, muted: Bool = false) async throws {
        let item = try await buildCompositionItem(videoURL: videoURL, audioURL: audioURL, durationHint: durationHint)
        applyItem(item, position: position, autoplay: autoplay, muted: muted)
    }

    private func applyItem(_ item: AVPlayerItem, position: Double, autoplay: Bool, muted: Bool) {
        // PiP-friendly swap: pause → replaceCurrentItem → resume. Direct
        // replacement on a playing player while PiP is active leaves the
        // PiP window stuck on the old item's last frame.
        let wasPlaying = player.rate > 0
        player.pause()
        player.replaceCurrentItem(with: item)
        if position > 0 {
            player.seek(to: CMTime(seconds: position, preferredTimescale: 600))
        }
        player.isMuted = muted
        isMuted = muted
        player.volume = muted ? 0 : 1
        if autoplay || wasPlaying {
            player.play()
            UIApplication.shared.isIdleTimerDisabled = true
        }
        // playerLayer.player already set in PlayerHostView.init.
        containerView.isHidden = false
    }

    private func buildCompositionItem(videoURL: URL, audioURL: URL, durationHint: Double) async throws -> AVPlayerItem {
        let opts: [String: Any] = [AVURLAssetPreferPreciseDurationAndTimingKey: true]
        let videoAsset = AVURLAsset(url: videoURL, options: opts)
        let audioAsset = AVURLAsset(url: audioURL, options: opts)

        async let vd: CMTime = videoAsset.load(.duration)
        async let ad: CMTime = audioAsset.load(.duration)
        async let vt = videoAsset.loadTracks(withMediaType: .video)
        async let at = audioAsset.loadTracks(withMediaType: .audio)
        let (vDur, aDur) = try await (vd, ad)

        func ok(_ t: CMTime) -> Bool {
            t.isValid && !t.isIndefinite && t.seconds.isFinite && t.seconds > 0
        }
        guard ok(vDur), ok(aDur) else {
            throw NSError(domain: "AVPlayerHost", code: -10, userInfo: [NSLocalizedDescriptionKey: "unusable duration"])
        }

        var duration = CMTimeMinimum(vDur, aDur)
        if durationHint > 0 {
            duration = CMTimeMinimum(duration, CMTime(seconds: durationHint, preferredTimescale: 600))
        }
        let range = CMTimeRange(start: .zero, duration: duration)

        let videoTracks = try await vt
        let audioTracks = try await at
        guard let videoTrack = videoTracks.first, let audioTrack = audioTracks.first else {
            throw NSError(domain: "AVPlayerHost", code: -11, userInfo: [NSLocalizedDescriptionKey: "missing tracks"])
        }

        let composition = AVMutableComposition()
        guard let cv = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let ca = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw NSError(domain: "AVPlayerHost", code: -12, userInfo: [NSLocalizedDescriptionKey: "track add failed"])
        }
        try cv.insertTimeRange(range, of: videoTrack, at: .zero)
        try ca.insertTimeRange(range, of: audioTrack, at: .zero)
        return AVPlayerItem(asset: composition)
    }

    // MARK: - Transport

    func play() { player.play(); UIApplication.shared.isIdleTimerDisabled = true }
    func pause() { player.pause(); UIApplication.shared.isIdleTimerDisabled = false }
    func stop() {
        player.pause()
        player.replaceCurrentItem(with: nil)
        UIApplication.shared.isIdleTimerDisabled = false
        containerView.isHidden = true
    }

    func seek(toSeconds s: Double) async {
        await player.seek(to: CMTime(seconds: s, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    /// Frame-accurate (HLS PDT-based) seek. Used by LiveSyncEngine.
    /// AVPlayer can't go to a Date that's outside the seekable window —
    /// returns false so caller can retry once the target is in range.
    @discardableResult
    func seek(toDate epochMs: Double) async -> Bool {
        guard let item = player.currentItem else { return false }
        let date = Date(timeIntervalSince1970: epochMs / 1000)
        return await item.seek(to: date)
    }

    func setRate(_ rate: Double) {
        player.rate = Float(rate)
    }

    // MARK: - Live state

    struct LiveState {
        let currentDateMs: Double?
        let liveEdgeMs: Double?
        let positionSec: Double
        let durationSec: Double
        let rate: Double
        let paused: Bool
    }

    func liveState() -> LiveState {
        let cur = player.currentItem
        var currentDateMs: Double? = nil
        if let d = cur?.currentDate() { currentDateMs = d.timeIntervalSince1970 * 1000 }
        let liveEdgeMs: Double? = nil
        // AVPlayerItem doesn't expose currentDate(after:) in modern SDKs;
        // LiveSyncEngine reads liveEdgeMs from server playback broadcasts.
        let pos = cur.flatMap { $0.currentTime().seconds.isFinite ? $0.currentTime().seconds : nil } ?? 0
        let dur = cur.flatMap { $0.duration.seconds.isFinite ? $0.duration.seconds : nil } ?? 0
        return LiveState(currentDateMs: currentDateMs, liveEdgeMs: liveEdgeMs,
                         positionSec: pos, durationSec: dur, rate: Double(player.rate), paused: player.rate == 0)
    }

    // MARK: - Layer frame

    func setLayerFrame(_ rect: CGRect, visible: Bool) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        containerView.frame = rect
        containerView.isHidden = !visible
        containerView.setNeedsLayout()
        if let pip, !pip.isPictureInPictureActive {
            pip.canStartPictureInPictureAutomaticallyFromInline = visible
        }
        CATransaction.commit()
    }

    // MARK: - PiP

    func startPip() {
        guard let pip, AVPictureInPictureController.isPictureInPictureSupported(),
              !pip.isPictureInPictureActive else { return }
        pip.startPictureInPicture()
    }

    func stopPip() {
        pip?.stopPictureInPicture()
    }

    private func installPipController() {
        guard pip == nil, AVPictureInPictureController.isPictureInPictureSupported() else { return }
        let p = AVPictureInPictureController(playerLayer: playerLayer)
        p?.canStartPictureInPictureAutomaticallyFromInline = false
        pip = p
    }

    // MARK: - Audio session + rate observer

    private func configureAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("[AVPlayerHost] audio session: \(error)")
        }
    }

    private func installRateObserver() {
        rateObserver = player.observe(\.rate, options: [.new]) { [weak self] p, _ in
            Task { @MainActor in self?.updateNowPlayingPlaybackState() }
        }
    }

    // MARK: - Now Playing + Remote Command Center

    func setNowPlaying(title: String, channel: String, durationSec: Double, positionSec: Double, isLive: Bool, artworkURL: String?) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: channel,
            MPMediaItemPropertyPlaybackDuration: durationSec,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: positionSec,
            MPNowPlayingInfoPropertyIsLiveStream: isLive,
            MPNowPlayingInfoPropertyPlaybackRate: player.rate
        ]
        if let art = nowPlayingArtwork {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: art.size) { _ in art }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        if let s = artworkURL, let url = URL(string: s) {
            Task { await self.loadArtwork(from: url) }
        }
    }

    private func loadArtwork(from url: URL) async {
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let img = UIImage(data: data) else { return }
            await MainActor.run {
                self.nowPlayingArtwork = img
                var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        } catch {}
    }

    func clearNowPlaying() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        nowPlayingArtwork = nil
    }

    private func updateNowPlayingPlaybackState() {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyPlaybackRate] = player.rate
        if let item = player.currentItem {
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = item.currentTime().seconds
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func installRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in self?.onRemotePlayPause?(); return .success }
        c.pauseCommand.addTarget { [weak self] _ in self?.onRemotePlayPause?(); return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in self?.onRemotePlayPause?(); return .success }
        c.skipForwardCommand.preferredIntervals = [15]
        c.skipBackwardCommand.preferredIntervals = [15]
        c.skipForwardCommand.addTarget { [weak self] _ in self?.onRemoteSkip?(15); return .success }
        c.skipBackwardCommand.addTarget { [weak self] _ in self?.onRemoteSkip?(-15); return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] event in
            if let e = event as? MPChangePlaybackPositionCommandEvent {
                self?.onRemoteSeek?(e.positionTime)
                return .success
            }
            return .commandFailed
        }
    }

    // MARK: - AirPlay

    func showAirPlayPicker() {
        if routePicker == nil {
            let v = AVRoutePickerView(frame: .zero)
            v.alpha = 0
            v.isUserInteractionEnabled = false
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first?.addSubview(v)
            routePicker = v
        }
        // Find the hidden picker's button and trigger it.
        if let v = routePicker {
            for sub in v.subviews {
                if let b = sub as? UIButton {
                    b.sendActions(for: .touchUpInside)
                    return
                }
            }
        }
    }

    // MARK: - Hardware volume KVO

    /// Active in sync mode (mpv on Mac is the "real" output). KVO
    /// outputVolume → emit a volume-bump event with sign of the delta
    /// → JS / Mac volume up/down 3%. After each press we silently
    /// restore phone volume to 0.5 via a hidden MPVolumeView so the
    /// phone level doesn't drift to 0/1.
    func enableVolumeIntercept() {
        guard !volumeInterceptEnabled else { return }
        volumeInterceptEnabled = true
        let s = AVAudioSession.sharedInstance()
        try? s.setActive(true)
        lastVolume = s.outputVolume
        volumeObserver = s.observe(\.outputVolume, options: [.new]) { [weak self] _, change in
            guard let self, let new = change.newValue else { return }
            Task { @MainActor in self.handleVolumeChange(new) }
        }
    }

    func disableVolumeIntercept() {
        volumeInterceptEnabled = false
        volumeObserver?.invalidate()
        volumeObserver = nil
    }

    private func handleVolumeChange(_ new: Float) {
        // Suppress our own restore — fire only if the value differs
        // from the last restore target by more than the noise floor
        // and the restore happened more than ~80ms ago.
        if let restoredAt = lastRestoreAt, abs(new - 0.5) < 0.005, Date().timeIntervalSince(restoredAt) < 0.08 {
            return
        }
        let delta = new - lastVolume
        if abs(delta) < 0.005 { return }
        let step = delta > 0 ? 3 : -3
        onVolumeButton?(step)
        // Restore to 0.5 silently via hidden MPVolumeView slider.
        restoreVolume(to: 0.5)
        lastVolume = new
    }

    private func restoreVolume(to value: Float) {
        let mpv = MPVolumeView(frame: CGRect(x: -1000, y: -1000, width: 1, height: 1))
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first?.addSubview(mpv)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            for sub in mpv.subviews {
                if let slider = sub as? UISlider {
                    slider.setValue(value, animated: false)
                    self?.lastRestoreAt = Date()
                    break
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { mpv.removeFromSuperview() }
        }
    }
}
