import SwiftUI

struct CommentsPanel: View {
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @Environment(UIStore.self) private var ui
    @State private var comments: [ApiClient.Comment] = []
    @State private var loading: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Comments").font(Font.app(14, weight: .semibold))
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 16)
            .padding(.bottom, 8)
            .foregroundStyle(Color.appText)

            Divider().background(Color.appText.opacity(0.1))

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if loading && comments.isEmpty {
                        Text("loading…").font(Font.app(12, design: .monospaced)).foregroundStyle(Color.appText.opacity(0.5)).padding()
                    } else if comments.isEmpty {
                        Text("No comments").font(Font.app(12, design: .monospaced)).foregroundStyle(Color.appText.opacity(0.4)).padding()
                    } else {
                        ForEach(comments) { c in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    Text(c.author ?? "anonymous").font(Font.app(12, weight: .semibold)).foregroundStyle(Color(hex: "#8ec07c"))
                                    if let likes = c.likeCount, likes > 0 {
                                        Text("\(likes)").font(Font.app(11)).foregroundStyle(Color.appText.opacity(0.4))
                                    }
                                    Spacer()
                                    if let p = c.publishedAt { Text(p).font(Font.app(10)).foregroundStyle(Color.appText.opacity(0.4)) }
                                }
                                Text(c.text ?? "")
                                    .font(Font.app(13))
                                    .foregroundStyle(Color.appText.opacity(0.85))
                            }
                            .padding(.horizontal, 14)
                        }
                    }
                }
                .padding(.vertical, 10)
            }
        }
        .task(id: playback.url) { await load() }
    }

    @MainActor
    private func load() async {
        guard let videoId = playback.url.firstMatch(of: /v=([\w-]+)/)?.output.1 else { return }
        loading = true
        defer { loading = false }
        comments = (try? await services.api.comments(videoId: String(videoId))) ?? []
    }
}
