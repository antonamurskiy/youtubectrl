import Foundation
import Observation

/// Phase 6 skeleton. Self-calibrating bias loop that keeps the iPhone's
/// AVPlayer locked to the Mac mpv's PDT for live HLS streams. Port the
/// math from `client/src/components/PhonePlayer.jsx` line-by-line; the
/// tunables below are validated against real lofi (5s segments) +
/// sl4m (2s segments) streams. Don't change them blindly.
///
/// Convergence: ~4-8 seeks, 20-30 seconds, settles |drift| < 50ms.
///
/// See CLAUDE.md > "Live Sync Architecture" for the full theory:
/// - PDT as the only sync currency (mpv & AVPlayer agree on segment PDT)
/// - Anchor system for stable scrubber math
/// - Self-calibrating bias loop for AVPlayer's segment-boundary undershoot
/// - MPV_DISPLAY_LAG_MS = 3 × TARGETDURATION (NOT a fixed constant)
@Observable
final class LiveSyncEngine {
    // MARK: tunables (match PhonePlayer.jsx — DO NOT change without validating on a real live stream)

    /// Aggressive learning rate; smaller values converge too slowly and
    /// the seek-threshold gate stops firing before convergence.
    let learningRate: Double = 0.7
    /// Below this, drift sits inside AVPlayer's per-seek jitter floor.
    let seekThresholdSec: Double = 0.5
    /// Minimum gap between seeks — HLS buffering needs to settle before
    /// post-seek measurement is trustworthy.
    let seekCooldownSec: Double = 2.5
    /// EMA window for displayed (smoothed) drift.
    let smoothingWindow: Int = 5
    /// "Stable" threshold for trusting the measurement.
    let stableVarianceMs: Double = 80

    // MARK: state

    var smoothedDriftMs: Double = 0
    var biasMs: Double = 0
    var lastSeekAt: Date? = nil
    var calibPending: Bool = false
    private var samples: [Double] = []

    // MARK: skeleton API

    /// Phase 6: run from a 1Hz Timer when `playback.isLive && phoneActive`.
    /// Reads mpv PDT from server (PlaybackPayload.absoluteMs) and AVPlayer's
    /// item.currentDate(); computes drift; decides whether to seek.
    func tick(mpvPdtMs: Double, phonePdtMs: Double?, host: AVPlayerHost) async {
        // TODO phase 6: implement.
        _ = mpvPdtMs; _ = phonePdtMs; _ = host
    }
}
