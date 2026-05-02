import Foundation
import Observation

/// VOD-mode counterpart to LiveSyncEngine. Keeps the iPhone AVPlayer
/// locked to mpv's interpolated VOD position so sync mode stays
/// aligned across the duration of a regular video.
///
/// Algorithm (matches PhonePlayer.jsx VOD sync interval):
///   - mpvPos = playback.interpolatedPosition (server position +
///     wall-clock elapsed since serverTs)
///   - phonePos = AVPlayer currentTime
///   - drift = mpvPos - phonePos
///   - hard-seek phone to mpvPos + 0.5s (latency comp) when
///     |drift| > 0.2s and >= 5s since last seek.
///   - track mpv pause/resume via playback.paused and mirror on
///     AVPlayer.
///   - detect mpv URL change (handled by PhoneModeStore.reloadForCurrentVideo).
@Observable
final class VodSyncEngine {
    let driftThresholdSec: Double = 0.2
    /// Once drift settles below this for `settledNeeded` ticks, freeze
    /// further seeks. Stops the periodic micro-jump at steady state.
    let settledThresholdSec: Double = 0.15
    let settledNeeded: Int = 4
    let seekCooldownSec: Double = 3.0
    let settleAfterStartSec: Double = 1.5
    /// Time after a seek before we trust the post-seek drift sample
    /// for bias learning.
    let postSeekSettleSec: Double = 2.0
    let learningRate: Double = 0.7

    private(set) var driftSec: Double = 0
    private(set) var lastSeekAt: Date? = nil
    /// Self-calibrating latency comp. Seeded at +0.5s, drifts toward
    /// AVPlayer's actual seek-settle delay over a few seek cycles via
    /// the learning loop in tick().
    private(set) var biasSec: Double = 0.5
    private var calibPending: Bool = false
    private var settledTicks: Int = 0
    private var startedAt: Date? = nil
    private var lastMpvPaused: Bool? = nil

    // Strong refs — the engine, host, and store are all owned by
    // ServiceContainer for the app's lifetime, so retain cycles
    // aren't a concern. Weak refs to `@Observable` types are
    // unreliable: under Swift 5.9's macro the optional weak var can
    // read as nil even when the underlying object is alive.
    private var host: AVPlayerHost?
    private var playback: PlaybackStore?
    private var api: ApiClient?
    private var ticker: Timer?
    private var clockOffsetMs: Double = 0
    private var enabled: Bool = false
    var debugLogging: Bool = true

    func attach(host: AVPlayerHost, playback: PlaybackStore, clockOffset: Double, api: ApiClient? = nil) {
        self.host = host
        self.playback = playback
        self.clockOffsetMs = clockOffset
        self.api = api
    }

    func updateClockOffset(_ offset: Double) {
        clockOffsetMs = offset
    }

    @MainActor
    func start() {
        guard !enabled else { return }
        enabled = true
        startedAt = Date()
        lastSeekAt = nil
        lastMpvPaused = nil
        calibPending = false
        settledTicks = 0
        // INTENTIONALLY NOT resetting biasSec here. Toggling Phone↔PC
        // calls stop() then start(); resetting bias would force the
        // learning loop to re-converge from 0.5s every toggle, taking
        // ~30s and 4-8 seeks. Bias gets reset explicitly via
        // resetForNewVideo() when the video URL actually changes.
        ticker = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    /// Called by PhoneModeStore when the video URL changes — last
    /// session's bias may be wrong for a new AVPlayer item with a
    /// different keyframe layout.
    @MainActor
    func resetForNewVideo() {
        biasSec = 0.5
        calibPending = false
        settledTicks = 0
        lastSeekAt = nil
        driftSec = 0
    }

    @MainActor
    func stop() {
        enabled = false
        ticker?.invalidate()
        ticker = nil
        startedAt = nil
        lastSeekAt = nil
        lastMpvPaused = nil
        calibPending = false
        settledTicks = 0
    }

    @MainActor
    private func tick() {
        guard enabled, let host, let pb = playback else { return }
        // Skip until AVPlayer has settled — early reads of currentTime
        // right after load come back as 0 and would trigger a phantom
        // big-drift seek back to start.
        if let s = startedAt, Date().timeIntervalSince(s) < settleAfterStartSec { return }
        // Don't run for live streams — LiveSyncEngine owns those.
        if pb.isLive { return }
        // No useful data yet.
        guard pb.duration > 0 else { return }

        // Mirror mpv pause/resume.
        if let last = lastMpvPaused, last != pb.paused {
            if pb.paused { host.pause() } else { host.play() }
        }
        lastMpvPaused = pb.paused

        // Don't seek when paused — drift is meaningless and will
        // grow at 1Hz simply because mpv-side time-pos isn't moving
        // while phone keeps wall-clock-interpolating.
        if pb.paused { return }

        let nowMs = Date().timeIntervalSince1970 * 1000
        let mpvPos = pb.interpolatedPosition(now: nowMs, clockOffset: clockOffsetMs)
        let phonePos = host.currentTimeSeconds
        guard phonePos.isFinite else { return }

        let drift = mpvPos - phonePos
        driftSec = drift

        // Bias learning — sample the post-seek residual once enough
        // time has passed for AVPlayer's seek to actually take effect,
        // then nudge biasSec by a fraction of the residual. After ~3
        // seeks the bias converges to AVPlayer's true seek-settle
        // latency and subsequent seeks land at zero drift instead of
        // bouncing at ±latencyComp forever.
        var calibrated = false
        if calibPending, let last = lastSeekAt,
           Date().timeIntervalSince(last) >= postSeekSettleSec {
            // Phone landed at mpvPos + biasSec at seek time. By now
            // mpv has advanced (seek-settle) more seconds. Phone
            // also advanced. Residual `drift` reflects how far OFF
            // the bias was: positive drift means phone is BEHIND
            // mpv → bias was too small → grow bias.
            let adjust = drift * learningRate
            biasSec += adjust
            // Clamp to reasonable bounds — runaway bias would seek
            // to a future timestamp far beyond the video's edge.
            biasSec = max(-2, min(5, biasSec))
            calibPending = false
            calibrated = true
        }

        // Settle detector — once we've held |drift| < settledThreshold
        // for enough consecutive ticks, freeze seeks. Stops the periodic
        // micro-jump at steady state.
        if abs(drift) < settledThresholdSec {
            settledTicks += 1
        } else {
            settledTicks = 0
        }
        let isSettled = settledTicks >= settledNeeded

        let cooldownOk: Bool = {
            guard let last = lastSeekAt else { return true }
            return Date().timeIntervalSince(last) >= seekCooldownSec
        }()

        // Force one more seek immediately after a calibration update,
        // so the newly-learned bias gets applied without waiting for
        // drift to grow back through the threshold.
        let willSeek = (calibrated || abs(drift) > driftThresholdSec)
                       && cooldownOk
                       && !isSettled
        if willSeek {
            let target = mpvPos + biasSec
            lastSeekAt = Date()
            calibPending = true
            Task { @MainActor in
                await host.seek(toSeconds: max(0, target))
            }
        }

        if debugLogging, let api {
            let payload: [String: Any] = [
                "tag": "vodsync",
                "driftMs": Int((drift * 1000).rounded()),
                "biasMs": Int((biasSec * 1000).rounded()),
                "settled": isSettled,
                "settledTicks": settledTicks,
                "mpvPos": mpvPos,
                "phonePos": phonePos,
                "paused": pb.paused,
                "playerRate": Double(host.player.rate),
                "willSeek": willSeek,
                "calibrated": calibrated,
                "calibPending": calibPending,
            ]
            Task { try? await api.clientLog(payload) }
        }
    }
}
