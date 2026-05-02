import SwiftUI

/// Floating sync diagnostics — visible only when phoneMode == .sync.
/// Shows live-sync engine state (drift, bias, last seek age) so the
/// user can confirm phone is locked to Mac without guessing.
struct SyncDiagnostics: View {
    @Environment(PhoneModeStore.self) private var phoneMode
    @Environment(ServiceContainer.self) private var services
    @Environment(PlaybackStore.self) private var playback

    var body: some View {
        if phoneMode.mode == .sync {
            VStack(alignment: .trailing, spacing: 2) {
                if playback.isLive {
                    if !playback.phoneSyncOk {
                        row("status", "no sync data")
                        row("hint", "server PDT N/A")
                    } else {
                        row("drift", driftLabel(services.liveSync.rawDriftMs))
                        row("smooth", fmt(services.liveSync.smoothedDriftMs, suffix: "ms"))
                        row("bias", fmt(services.liveSync.biasMs, suffix: "ms"))
                        row("seek", lastSeekAge)
                    }
                    row("live", "yes")
                } else {
                    row("drift", fmt(services.vodSync.driftSec * 1000, suffix: "ms"))
                    row("seek", vodLastSeekAge)
                    row("vod", "yes")
                }
            }
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(Color.appText.opacity(0.85))
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .allowsHitTesting(false)
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(spacing: 6) {
            Text(label).foregroundStyle(Color.appText.opacity(0.55))
            Text(value).monospacedDigit()
        }
    }

    private func fmt(_ ms: Double, suffix: String) -> String {
        let sign = ms >= 0 ? "+" : ""
        return "\(sign)\(Int(ms.rounded()))\(suffix)"
    }

    /// Show "—" when AVPlayer hasn't reported a valid PDT yet
    /// (rawDrift = current-epoch minus 0 = ~56 years of nonsense).
    private func driftLabel(_ ms: Double) -> String {
        if abs(ms) > 1_000_000 { return "—" }
        return fmt(ms, suffix: "ms")
    }

    private var lastSeekAge: String {
        guard let t = services.liveSync.lastSeekAt else { return "—" }
        let age = Date().timeIntervalSince(t)
        return "\(Int(age))s ago"
    }

    private var vodLastSeekAge: String {
        guard let t = services.vodSync.lastSeekAt else { return "—" }
        let age = Date().timeIntervalSince(t)
        return "\(Int(age))s ago"
    }
}
