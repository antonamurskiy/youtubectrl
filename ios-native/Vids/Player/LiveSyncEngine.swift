import Foundation
import Observation

/// Phase 6 — port from `client/src/components/PhonePlayer.jsx` sync
/// interval. Self-calibrating bias loop keeping phone AVPlayer locked
/// to Mac mpv's PDT for live HLS.
///
/// Convergence: ~4-8 seeks, 20-30s, settles |drift| < 50ms.
///
/// Tunables match PhonePlayer.jsx exactly. **Validate against real
/// lofi (5s segments) and sl4m (2s segments) before changing.**
@Observable
final class LiveSyncEngine {
    // Tunables
    let learningRate: Double = 0.7
    // 0.5s threshold + 2.5s cooldown — micro-corrects the natural
    // decoder-clock drift between mpv and phone (±50-100ms over time
    // if uncorrected). The earlier bump to 1.5s left drift uncorrected
    // and the user perceived ±70ms wobble. Combined with the
    // phoneSyncOk gate (server only broadcasts absoluteMs when valid)
    // and outlier 3600s, occasional small seeks are fine.
    let seekThresholdSec: Double = 0.5
    let seekCooldownSec: Double = 2.5
    let smoothingWindow: Int = 5
    let stableVarianceMs: Double = 80
    // Bumped 10 → 3600 — initial drift can legitimately be 20-60s
    // when phone first joins (AVPlayer's HLS live-edge buffer vs
    // mpv's streamlink buffer). Only filter true PDT-garbage values
    // (e.g. phonePdt == 0 → year-2026 ms drift). 1-hour cap handles
    // that without blocking the initial align seek.
    let outlierThresholdSec: Double = 3600
    let postSeekSettleSec: Double = 2.0
    let stableSampleCount: Int = 3

    // State
    private(set) var smoothedDriftMs: Double = 0
    private(set) var biasMs: Double = 0
    private(set) var rawDriftMs: Double = 0
    private(set) var lastSeekAt: Date? = nil
    private(set) var calibPending: Bool = false
    private var samples: [Double] = []
    private var postSeekSamples: [Double] = []

    private weak var host: AVPlayerHost?
    private var ticker: Timer?
    private var clockOffsetMs: Double = 0
    private var enabled: Bool = false

    func attach(host: AVPlayerHost, clockOffset: Double) {
        self.host = host
        self.clockOffsetMs = clockOffset
    }

    func start() {
        guard !enabled else { return }
        enabled = true
        // 1Hz tick — matches PhonePlayer.jsx sync interval frequency.
        ticker = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    func stop() {
        enabled = false
        ticker?.invalidate()
        ticker = nil
        samples.removeAll()
        postSeekSamples.removeAll()
        calibPending = false
    }

    func reset() {
        smoothedDriftMs = 0
        biasMs = 0
        rawDriftMs = 0
        lastSeekAt = nil
        calibPending = false
        samples.removeAll()
        postSeekSamples.removeAll()
    }

    /// Call from PlaybackStore broadcast tick to update the cached
    /// clock offset (recalibrates every 5min via WS ping/pong).
    func updateClockOffset(_ offset: Double) {
        clockOffsetMs = offset
    }

    /// `mpvPdtMs` is the server's `playback.absoluteMs` — wall-clock PDT
    /// of the frame mpv is showing right now. `serverTs` is when the
    /// server computed it; we add the wall-clock elapsed since.
    func setServerPDT(_ mpvPdtMs: Double, serverTs: Double) {
        serverPdtMs = mpvPdtMs
        self.serverTsMs = serverTs
    }
    private var serverPdtMs: Double = 0
    private var serverTsMs: Double = 0

    /// When true, every tick POSTs its full state to /api/client-log
    /// so I can `tail -f /tmp/ytctl-client.log` and tweak parameters
    /// against real readings.
    var debugLogging: Bool = true
    var api: ApiClient?

    private func tick() {
        guard enabled, let host else { return }
        // Server's PDT now = serverPdtMs + (wall-clock since serverTs).
        let nowMs = Date().timeIntervalSince1970 * 1000
        // elapsed = (nowMs + clockOffsetMs - serverTsMs), clamped [0, 2000].
        let elapsed = max(0, min(2000, nowMs + clockOffsetMs - serverTsMs))
        let mpvPdtNow = serverPdtMs + elapsed

        let liveState = host.liveState()
        guard let phonePdt = liveState.currentDateMs else { return }

        let drift = (mpvPdtNow - phonePdt) / 1000  // positive = phone behind
        rawDriftMs = drift * 1000

        // Drop outliers from EMA — AVPlayer reports stale dates while
        // HLS first loads (drift readings of 7000+s).
        if abs(drift) < outlierThresholdSec {
            samples.append(drift * 1000)
            if samples.count > smoothingWindow { samples.removeFirst() }
            smoothedDriftMs = samples.reduce(0, +) / Double(samples.count)
        }

        let cooldownOk: Bool = {
            guard let last = lastSeekAt else { return true }
            return Date().timeIntervalSince(last) >= seekCooldownSec
        }()

        // Calibrate from post-seek samples once stable.
        if calibPending, let last = lastSeekAt, Date().timeIntervalSince(last) >= postSeekSettleSec {
            postSeekSamples.append(drift * 1000)
            let recent = Array(postSeekSamples.suffix(stableSampleCount))
            if recent.count >= stableSampleCount {
                let mean = recent.reduce(0, +) / Double(recent.count)
                let variance = recent.map { abs($0 - mean) }.max() ?? 0
                if variance <= stableVarianceMs {
                    biasMs += (mean * learningRate).rounded()
                    calibPending = false
                    postSeekSamples.removeAll()
                    // Force a follow-up seek to apply the new bias —
                    // without this, drift drops below threshold and
                    // the loop stalls before converging.
                    forceSeek(targetPdtMs: mpvPdtNow + biasMs, host: host)
                }
            }
        }

        // Seek if drift exceeds threshold AND cooldown elapsed AND
        // drift isn't an outlier (AVPlayer reports stale PDT during
        // HLS load — drifts of -56 years are noise, not signal).
        let shouldSeek = (abs(drift) >= seekThresholdSec)
                         && (abs(drift) < outlierThresholdSec)
                         && cooldownOk
        if shouldSeek {
            forceSeek(targetPdtMs: mpvPdtNow + biasMs, host: host)
        }

        if debugLogging, let api {
            let payload: [String: Any] = [
                "tag": "livesync",
                "rawDriftMs": Int(rawDriftMs.rounded()),
                "smoothedMs": Int(smoothedDriftMs.rounded()),
                "biasMs": Int(biasMs),
                "mpvPdt": Int(mpvPdtNow),
                "phonePdt": Int(phonePdt),
                "elapsed": Int(elapsed),
                "calibPending": calibPending,
                "shouldSeek": shouldSeek,
                "cooldownOk": cooldownOk,
                "secondsSinceSeek": lastSeekAt.map { Int(Date().timeIntervalSince($0)) } ?? -1,
            ]
            Task { try? await api.clientLog(payload) }
        }
    }

    private func forceSeek(targetPdtMs: Double, host: AVPlayerHost) {
        lastSeekAt = Date()
        calibPending = true
        postSeekSamples.removeAll()
        Task { @MainActor in
            _ = await host.seek(toDate: targetPdtMs)
        }
    }
}
