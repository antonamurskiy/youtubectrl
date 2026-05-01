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
                Text("Quality").font(Font.app(14, weight: .semibold))
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 8)
            .foregroundStyle(Color.appText)

            Divider().background(Color.appText.opacity(0.1))

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
            .padding(.vertical, 12)
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
