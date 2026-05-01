import SwiftUI

/// Floating storyboard preview tile, rendered as a sibling overlay of
/// the NowPlayingBar (NOT a descendant) so the bar's
/// `.glassEffect(in:)` shape doesn't clip it. Mirrors AVKit's scrub
/// preview architecture.
///
/// Uses `barFrameInScreen` (published by the NPBar via PreferenceKey)
/// to position the tile horizontally along the scrubber and vertically
/// just above the bar's top edge.
struct ScrubPreviewOverlay: View {
    @Environment(ScrubState.self) private var scrub
    let barFrame: CGRect

    var body: some View {
        // Debug indicator — always visible when scrubbing, even if the
        // tile path fails. Confirms whether ScrubState updates are
        // reaching the overlay at all.
        ZStack(alignment: .topLeading) {
            if scrub.active {
                Text("scrub active pct=\(String(format: "%.2f", scrub.pct)) bar=\(Int(barFrame.minX)),\(Int(barFrame.minY)) \(Int(barFrame.width))x\(Int(barFrame.height))")
                    .font(.caption2.monospaced())
                    .padding(6)
                    .background(.red)
                    .foregroundStyle(.white)
                    .position(x: 200, y: 100)
            }
            if scrub.active && barFrame.width > 0 {
                content(scrub: scrub)
                    .transition(.opacity.combined(with: .scale(scale: 0.95, anchor: .bottom)))
            }
        }
    }

    @ViewBuilder
    private func content(scrub: ScrubState) -> some View {
        // Bar's scrubber inset: matches ScrubberUIView.insetBy(dx: 14)
        // plus the bar's own outer padding (8pt horizontal in RootView).
        let scrubInset: CGFloat = 14
        let trackWidth = barFrame.width - scrubInset * 2
        let cx = barFrame.minX + scrubInset + trackWidth * scrub.pct

        let tileW: CGFloat = 132
        let tileH: CGFloat = 76 // ~16:9
        let lo: CGFloat = barFrame.minX + 8
        let hi: CGFloat = barFrame.maxX - tileW - 8
        let tileX: CGFloat = max(lo, min(hi, cx - tileW / 2))
        let tileY: CGFloat = barFrame.minY - tileH - 28

        VStack(spacing: 6) {
            Group {
                if let img = scrub.image {
                    Image(uiImage: img).resizable().scaledToFill()
                } else {
                    Color.black.opacity(0.5)
                }
            }
            .frame(width: tileW, height: tileH)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.25), lineWidth: 0.5)
            )
            .shadow(color: .black.opacity(0.4), radius: 12, y: 4)

            Text(scrub.label)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .foregroundStyle(Color.white)
                .glassEffect(.regular.tint(.black.opacity(0.5)), in: Capsule())
        }
        .position(x: tileX + tileW / 2, y: tileY + tileH / 2)
        .allowsHitTesting(false)
    }
}

/// PreferenceKey that publishes the NPBar's frame in screen-global
/// coordinates so the overlay can position the preview correctly.
struct NPBarFrameKey: PreferenceKey {
    static var defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        value = nextValue()
    }
}
