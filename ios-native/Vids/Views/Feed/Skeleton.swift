import SwiftUI

/// Lightweight shimmer placeholder for the empty-feed state.
struct FeedSkeleton: View {
    @State private var phase: CGFloat = -1

    var body: some View {
        VStack(spacing: 12) {
            ForEach(0..<5, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 6) {
                    shimmerBar.aspectRatio(16.0/9.0, contentMode: .fit)
                    shimmerBar.frame(height: 14).padding(.horizontal, 12)
                    shimmerBar.frame(height: 11).padding(.horizontal, 12).padding(.trailing, 60)
                }
            }
        }
        .padding(.vertical, 16)
        .onAppear {
            withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) {
                phase = 1.5
            }
        }
    }

    private var shimmerBar: some View {
        Rectangle()
            .fill(Color.appText.opacity(0.05))
            .overlay(
                LinearGradient(
                    colors: [.clear, Color.appText.opacity(0.08), .clear],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .offset(x: phase * 280)
            )
            .clipped()
    }
}
