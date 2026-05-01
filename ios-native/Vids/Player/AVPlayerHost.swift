import Foundation
import AVKit
import AVFoundation
import UIKit
import Observation

/// Phase 5 skeleton. Owns a single AVPlayer + AVPlayerLayer, hosts an
/// inline view that overlays the React-equivalent placeholder rect, and
/// drives PiP via AVPictureInPictureController.
///
/// Phase 5 finish: port from `ios-app/ios/App/App/NativePlayerPlugin.swift`
/// (1209 LOC) — DASH 137+140 composition, format-22 fallback, MPNowPlayingInfoCenter
/// + MPRemoteCommandCenter wiring, PiP-friendly item swap (pause →
/// replaceCurrentItem → play, NOT swap on a playing player), the
/// `automaticallyPreservesTimeOffsetFromLive = false` invariant, hidden
/// AVRoutePickerView for AirPlay, isIdleTimerDisabled keep-awake, KVO
/// outputVolume for hardware-button drive of Mac volume.
///
/// The original Swift code in `ios-app/` is the reference implementation
/// — copy its invariants verbatim during the port. Each one took
/// multiple iterations to get right (see CLAUDE.md > "Phone Mode").
@Observable
final class AVPlayerHost {
    let player: AVPlayer = {
        let p = AVPlayer()
        p.allowsExternalPlayback = true
        return p
    }()
    let containerView: UIView = {
        let v = UIView()
        v.backgroundColor = .black
        v.isHidden = true
        return v
    }()
    private let playerLayer: AVPlayerLayer
    private var pip: AVPictureInPictureController?

    var playing: Bool = false
    var liveCurrentDateMs: Double? = nil

    init() {
        playerLayer = AVPlayerLayer(player: player)
        playerLayer.videoGravity = .resizeAspect
        containerView.layer.addSublayer(playerLayer)
        configureAudioSession()
        if AVPictureInPictureController.isPictureInPictureSupported() {
            pip = AVPictureInPictureController(playerLayer: playerLayer)
            pip?.canStartPictureInPictureAutomaticallyFromInline = false
        }
    }

    func load(url: URL) {
        let item = AVPlayerItem(url: url)
        // CLAUDE.md: critical invariant — without this, AVPlayer fights
        // our seeks by drifting back to its own configured live offset.
        item.automaticallyPreservesTimeOffsetFromLive = false
        // Phase 5: PiP-friendly swap pattern — pause → replace → play.
        let wasPlaying = player.rate > 0
        player.pause()
        player.replaceCurrentItem(with: item)
        if wasPlaying { player.play() }
    }

    func play() { player.play(); playing = true }
    func pause() { player.pause(); playing = false }

    /// Frame-accurate seek using the AVPlayerItem's PDT track. Used by
    /// LiveSyncEngine.
    func seek(toDate epochMs: Double) async -> Bool {
        guard let item = player.currentItem else { return false }
        let date = Date(timeIntervalSince1970: epochMs / 1000)
        return await item.seek(to: date)
    }

    /// Position the inline AVPlayerLayer to match a placeholder rect from
    /// the SwiftUI view tree (phase 5: hooked when sync mode mounts).
    func setLayerFrame(_ rect: CGRect, visible: Bool) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        playerLayer.frame = rect
        containerView.frame = rect
        containerView.isHidden = !visible
        CATransaction.commit()
        if let pip = pip, !pip.isPictureInPictureActive {
            pip.canStartPictureInPictureAutomaticallyFromInline = visible
        }
    }

    private func configureAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("[AVPlayerHost] audio session setup failed: \(error)")
        }
    }
}
