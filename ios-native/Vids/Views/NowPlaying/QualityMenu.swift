import SwiftUI

struct QualityMenu: View {
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @Environment(UIStore.self) private var ui
    @State private var formats: [ApiClient.Format] = []
    @State private var loading: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Quality").font(Font.app(13, weight: .semibold))
                Spacer()
                Button(action: { ui.qualityMenuOpen = false }) {
                    Image(systemName: "xmark").font(.system(size: 13))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .foregroundStyle(Color.appText)

            Divider().background(.white.opacity(0.1))

            ScrollView {
                LazyVStack(spacing: 0) {
                    row(label: "Best", format: "bv*+ba/b")
                    if loading { Text("loading…").font(Font.app(11, design: .monospaced)).foregroundStyle(Color.appText.opacity(0.4)).padding() }
                    ForEach(formats, id: \.self) { f in
                        if let label = f.label, let fmt = f.format { row(label: label, format: fmt) }
                    }
                }
            }
        }
        .background(Color(hex: "#151515"))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .frame(maxWidth: 320)
        .frame(maxHeight: 400)
        .task { await loadFormats() }
    }

    private func row(label: String, format: String) -> some View {
        Button(action: {
            Task { try? await services.api.setQuality(format: format) }
            ui.qualityMenuOpen = false
        }) {
            HStack {
                Text(label).font(Font.app(13))
                Spacer()
            }
            .foregroundStyle(Color.appText.opacity(0.85))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Color(hex: "#0a0a0a"))
        }
        .buttonStyle(.plain)
    }

    @MainActor
    private func loadFormats() async {
        guard !playback.url.isEmpty else { return }
        loading = true
        defer { loading = false }
        formats = (try? await services.api.formats(url: playback.url)) ?? []
    }
}
