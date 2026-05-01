import SwiftUI

struct HeaderView: View {
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services
    @Environment(PlaybackStore.self) private var playback
    @Binding var searchFocused: Bool
    @State private var searchText: String = ""

    var body: some View {
        HStack(spacing: 8) {
            Button(action: home) {
                Image(systemName: "play.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white.opacity(0.85))
                    .frame(width: 28, height: 28)
            }

            TextField("Search", text: $searchText)
                .textFieldStyle(.plain)
                .submitLabel(.search)
                .onSubmit { Task { await feed.search(searchText, api: services.api) } }
                .padding(.horizontal, 8)
                .frame(height: 30)

            HStack(spacing: 4) {
                ForEach(FeedTab.allCases) { tab in
                    Button(action: { feed.activeTab = tab }) {
                        Text(tab.label)
                            .font(.system(size: 12, weight: .semibold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(feed.activeTab == tab ? .white.opacity(0.15) : .clear)
                            .foregroundStyle(.white.opacity(feed.activeTab == tab ? 1 : 0.55))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                    .buttonStyle(.plain)
                }
            }

            HStack(spacing: 3) {
                StatusDot(on: true)
                StatusDot(on: playback.macStatus.ethernet ?? false)
                StatusDot(on: !(playback.macStatus.locked ?? false))
                StatusDot(on: !(playback.macStatus.screenOff ?? false))
            }
            .frame(width: 36, height: 28)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private func home() {
        feed.activeTab = .rec
        searchText = ""
    }
}

private struct StatusDot: View {
    let on: Bool
    var body: some View {
        Circle()
            .fill(on ? Color(hex: "#8ec07c") : Color(hex: "#3c3836"))
            .frame(width: 5, height: 5)
    }
}
