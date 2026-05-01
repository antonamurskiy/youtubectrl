import SwiftUI

struct HeaderView: View {
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services
    @Environment(PlaybackStore.self) private var playback
    @Binding var searchFocused: Bool
    @State private var searchText: String = ""

    var body: some View {
        VStack(spacing: 6) {
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
                    .foregroundStyle(.white)
                    .tint(.white)
                    .onSubmit { Task { await feed.search(searchText, api: services.api) } }
                    .padding(.horizontal, 8)
                    .frame(maxWidth: .infinity, minHeight: 30)

                HStack(spacing: 3) {
                    StatusDot(on: true)
                    StatusDot(on: playback.macStatus.ethernet ?? false)
                    StatusDot(on: !(playback.macStatus.locked ?? false))
                    StatusDot(on: !(playback.macStatus.screenOff ?? false))
                }
            }
            .padding(.horizontal, 12)

            HStack(spacing: 4) {
                ForEach(FeedTab.allCases) { tab in
                    Button(action: { feed.activeTab = tab; Task { await feed.load(tab: tab, api: services.api) } }) {
                        Text(tab.label)
                            .font(.system(size: 12, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(feed.activeTab == tab ? Color.white.opacity(0.18) : Color.white.opacity(0.04))
                            .foregroundStyle(.white.opacity(feed.activeTab == tab ? 1 : 0.55))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
        }
        .padding(.top, 4)
        .padding(.bottom, 6)
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
