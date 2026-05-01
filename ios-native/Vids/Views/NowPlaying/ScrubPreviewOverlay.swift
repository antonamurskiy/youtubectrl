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
    /// NP bar height (works via NPBarHeightKey). We don't need the full
    /// frame — the bar always spans the screen bottom, so screen size +
    /// npBarHeight is enough to compute where the scrubber track lives.
    let barHeight: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Debug breadcrumb so we can tell which link is broken.
            // Always visible while scrubbing: state truthiness, percent,
            // bar height. If this doesn't show at all, scrub.active
            // isn't being mutated. If it shows with barH=0, the
            // height preference isn't reaching us.
            if scrub.active {
                Text("active=\(scrub.active) pct=\(String(format: "%.2f", scrub.pct)) barH=\(Int(barHeight)) hasImg=\(scrub.image != nil ? "Y" : "N")")
                    .font(.caption2.monospaced())
                    .padding(6)
                    .background(.red)
                    .foregroundStyle(.white)
                    .position(x: 200, y: 80)
            }
            if scrub.active && barHeight > 0 {
                content(scrub: scrub)
                    .transition(.opacity.combined(with: .scale(scale: 0.95, anchor: .bottom)))
            }
        }
    }

    @ViewBuilder
    private func content(scrub: ScrubState) -> some View {
        // The bar spans the full screen bottom. Scrubber track inset
        // matches ScrubberUIView.insetBy(dx: 14) + bar's own 8pt
        // horizontal outer padding.
        let screen = UIScreen.main.bounds
        let scrubInset: CGFloat = 14 + 8
        let trackWidth = screen.width - scrubInset * 2
        let cx = scrubInset + trackWidth * scrub.pct

        let tileW: CGFloat = 200
        let tileH: CGFloat = tileW * 9.0 / 16.0  // exact 16:9 — no letterbox
        let lo: CGFloat = 8
        let hi: CGFloat = screen.width - tileW - 8
        let tileX: CGFloat = max(lo, min(hi, cx - tileW / 2))
        // Bar sits at screen.height - barHeight; preview floats above.
        let tileY: CGFloat = screen.height - barHeight - tileH - 28

        VStack(spacing: 6) {
            ZStack {
                Color.black
                if let img = scrub.image {
                    // .scaledToFit fits the image inside the frame
                    // without overflowing — .scaledToFill was making
                    // the image render larger than the 200×112 box
                    // because the source storyboard crop is at full
                    // ytimg resolution (e.g. 320×180) and scaledToFill
                    // sizes by the longer side.
                    Image(uiImage: img).resizable().scaledToFit()
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
