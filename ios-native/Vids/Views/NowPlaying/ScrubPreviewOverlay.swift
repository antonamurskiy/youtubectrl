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
    /// NP bar height (works via NPBarHeightKey).
    let barHeight: CGFloat
    /// How far the NP bar is lifted off the screen bottom (e.g. tab
    /// bar height when MainTabView's bar is showing). Default 0.
    var bottomOffset: CGFloat = 0

    var body: some View {
        if scrub.active && barHeight > 0 {
            content(scrub: scrub)
                .transition(.opacity.combined(with: .scale(scale: 0.95, anchor: .bottom)))
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

        // Match the actual storyboard tile aspect (16:9 default; some
        // streams use 4:3 or vertical) so the image fills the frame
        // exactly with no letterbox or crop.
        let tileW: CGFloat = 200
        let tileH: CGFloat = tileW / max(0.5, scrub.aspect)
        let lo: CGFloat = 8
        let hi: CGFloat = screen.width - tileW - 8
        let tileX: CGFloat = max(lo, min(hi, cx - tileW / 2))
        // Bar sits at screen.height - barHeight - bottomOffset.
        let tileY: CGFloat = screen.height - barHeight - bottomOffset - tileH - 28

        VStack(spacing: 6) {
            // Show the image at its natural aspect — let the IMAGE
            // determine the frame, not the other way around. Anything
            // we predefine for the frame will mismatch the source by
            // ~0.5–2pt and produce visible bars or crop.
            Group {
                if let img = scrub.image {
                    Image(uiImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: tileW)
                } else {
                    Color.black
                        .aspectRatio(scrub.aspect, contentMode: .fit)
                        .frame(width: tileW)
                }
            }
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
