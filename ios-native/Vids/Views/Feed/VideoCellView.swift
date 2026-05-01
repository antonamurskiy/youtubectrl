import SwiftUI

struct VideoCellView: View {
    let video: Video
    @State private var thumbnail: UIImage? = nil
    @Environment(FontStore.self) private var fonts

    var body: some View {
        let _ = fonts.generation
        let _ = fonts.label
        return VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                Group {
                    if let img = thumbnail {
                        Image(uiImage: img)
                            .resizable()
                            .aspectRatio(16.0/9.0, contentMode: .fill)
                    } else {
                        Color.black.opacity(0.6)
                            .aspectRatio(16.0/9.0, contentMode: .fit)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 0))

                if let dur = video.duration, !dur.isEmpty {
                    Text(dur == "LIVE" ? "LIVE" : dur)
                        .font(Font.app(11, weight: .semibold, design: .monospaced))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.black.opacity(0.75))
                        .foregroundStyle(.white)
                        .padding(8)
                }
                // Watched-progress strip at the bottom of the thumbnail.
                if let pos = video.savedPosition, let dur = video.savedDuration, dur > 0, pos > 0 {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(.black.opacity(0.5)).frame(height: 3)
                            Rectangle().fill(Color(hex: "#cc4040"))
                                .frame(width: geo.size.width * CGFloat(min(pos / dur, 1)), height: 3)
                        }
                        .frame(maxHeight: .infinity, alignment: .bottom)
                    }
                    .allowsHitTesting(false)
                }
            }
            .clipped()

            VStack(alignment: .leading, spacing: 2) {
                Text(video.title ?? "")
                    .font(Font.app(14, weight: .semibold))
                    .lineLimit(2)
                    .foregroundStyle(.white)
                HStack(spacing: 6) {
                    if let ch = video.channel { Text(ch) }
                    if let v = video.views { Text("• \(v)") }
                    if let u = video.uploadedAt { Text("• \(u)") }
                }
                .font(Font.app(12))
                .foregroundStyle(.white.opacity(0.55))
            }
            .padding(.horizontal, 12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
                .foregroundStyle(.white)
                .frame(width: 140, alignment: .leading)
        }
        .task(id: short.videoId) {
            guard let id = short.videoId else { return }
            let url = short.thumbnail ?? "https://i.ytimg.com/vi/\(id)/hqdefault.jpg"
            thumbnail = await ThumbnailCache.shared.image(id: id, url: url)
        }
    }
}
