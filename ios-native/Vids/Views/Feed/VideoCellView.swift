import SwiftUI

struct VideoCellView: View {
    let video: Video
    @State private var thumbnail: UIImage? = nil
    @Environment(FontStore.self) private var fonts

    var body: some View {
        let _ = fonts.generation
        let _ = fonts.label
        return VStack(alignment: .leading, spacing: 6) {
            // Single thumbnail container — overlays attach directly so
            // the layout doesn't have an unstable ZStack with multiple
            // .frame(maxWidth:.infinity) siblings. iOS 26 was hitting
            // recursive _updateVisibleCellsNow when the size cycled
            // through children.
            // Hard-pin to integer-pixel dimensions — fractional sizes
            // (e.g., 393 * 9/16 = 220.6875) round differently per
            // scroll offset and produce sub-pixel jitter as cells
            // recompose.
            let thumbW = floor(UIScreen.main.bounds.width)
            let thumbH = floor(thumbW * 9 / 16)
            Color.black.opacity(0.6)
                .frame(width: thumbW, height: thumbH)
                .overlay {
                    if let img = thumbnail {
                        Image(uiImage: img)
                            .resizable()
                            .scaledToFill()
                            .frame(width: thumbW, height: thumbH)
                            .clipped()
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    if let dur = video.duration, !dur.isEmpty {
                        Text(dur == "LIVE" ? "LIVE" : dur)
                            .font(Font.app(11, weight: .semibold, design: .monospaced))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.black.opacity(0.75))
                            .foregroundStyle(Color.appText)
                            .padding(8)
                    }
                }
                .overlay(alignment: .bottom) {
                    if let pos = video.savedPosition, let dur = video.savedDuration, dur > 0, pos > 0 {
                        let pct = min(max(pos / dur, 0), 1)
                        LinearGradient(
                            stops: [
                                .init(color: Color(hex: "#cc4040"), location: 0),
                                .init(color: Color(hex: "#cc4040"), location: pct),
                                .init(color: .black.opacity(0.5),  location: pct),
                                .init(color: .black.opacity(0.5),  location: 1),
                            ],
                            startPoint: .leading, endPoint: .trailing
                        )
                        .frame(height: 3)
                        .allowsHitTesting(false)
                    }
                }
                .clipped()

            VStack(alignment: .leading, spacing: 2) {
                Text(video.title ?? "")
                    .font(Font.app(14, weight: .semibold))
                    .lineLimit(2)
                    .foregroundStyle(Color.appText)
                HStack(spacing: 6) {
                    if let ch = video.channel { Text(ch) }
                    if let v = video.views { Text("• \(v)") }
                    if let u = video.uploadedAt { Text("• \(u)") }
                }
                .font(Font.app(12))
                .foregroundStyle(Color.appText.opacity(0.55))
            }
            .padding(.horizontal, 12)
        }
        // Pin to top-leading inside the cell's absolute frame so
        // shorter titles (1 line vs 2 lines) don't let SwiftUI
        // redistribute spacing — content was visibly shifting
        // vertically per cell because the VStack stretched to fill.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .transaction { $0.animation = nil }
        .task(id: video.videoId) { await loadThumb() }
    }

    private func loadThumb() async {
        guard let id = video.videoId else { return }
        let url = video.thumbnail ?? "https://i.ytimg.com/vi/\(id)/hqdefault.jpg"
        thumbnail = await ThumbnailCache.shared.image(id: id, url: url)
    }
}

struct ShortCellView: View {
    let short: Short
    @State private var thumbnail: UIImage? = nil
    @Environment(FontStore.self) private var fonts

    var body: some View {
        let _ = fonts.generation
        let _ = fonts.label
        return VStack(alignment: .leading, spacing: 4) {
            Group {
                if let img = thumbnail {
                    Image(uiImage: img).resizable().aspectRatio(9.0/16.0, contentMode: .fill)
                } else {
                    Color.black.opacity(0.6).aspectRatio(9.0/16.0, contentMode: .fit)
                }
            }
            .frame(width: 140, height: 180)
            .clipped()
            Text(short.title ?? "")
                .font(Font.app(12, weight: .semibold))
                .lineLimit(2)
                .foregroundStyle(Color.appText)
                .frame(width: 140, alignment: .leading)
        }
        .task(id: short.videoId) {
            guard let id = short.videoId else { return }
            let url = short.thumbnail ?? "https://i.ytimg.com/vi/\(id)/hqdefault.jpg"
            thumbnail = await ThumbnailCache.shared.image(id: id, url: url)
        }
    }
}
