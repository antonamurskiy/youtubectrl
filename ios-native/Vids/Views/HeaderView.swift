import SwiftUI

struct HeaderView: View {
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services
    @Environment(PlaybackStore.self) private var playback
    @Environment(ThemeStore.self) private var theme
    @Binding var searchFocused: Bool
    @State private var searchText: String = ""
    @State private var searchTask: Task<Void, Never>? = nil

    var body: some View {
        // Single-row header: home / search / tabs (right) / status dots.
        HStack(spacing: 6) {
            Button(action: home) {
                Image(systemName: "play.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white.opacity(0.85))
                    .frame(width: 26, height: 26)
            }

            TextField("Search", text: $searchText)
                .textFieldStyle(.plain)
                .submitLabel(.search)
                .foregroundStyle(.white)
                .tint(.white)
                .onChange(of: searchText) { _, new in
                    searchTask?.cancel()
                    searchTask = Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 350_000_000)
                        guard !Task.isCancelled else { return }
                        await feed.search(new, api: services.api)
                    }
                }
                .onSubmit {
                    searchTask?.cancel()
                    Task { await feed.search(searchText, api: services.api) }
                }
                .frame(maxWidth: .infinity, minHeight: 28)

            // Tabs on the right.
            HStack(spacing: 2) {
                ForEach(FeedTab.allCases) { tab in
                    Button(action: { feed.activeTab = tab; Task { await feed.load(tab: tab, api: services.api) } }) {
                        Text(tab.label)
                            .font(.system(size: 11, weight: .semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 4)
                            .background(tabBg(tab))
                            .foregroundStyle(feed.activeTab == tab ? .white : .white.opacity(0.55))
                            .clipShape(RoundedRectangle(cornerRadius: 3))
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
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func tabBg(_ tab: FeedTab) -> Color {
        guard feed.activeTab == tab else { return Color.white.opacity(0.04) }
        // Active pill: lightened version of the tab tint (matches React's
        // --tab-active-bg = mix(tint, white, 15%)). Falls back to a
        // neutral highlight when no tint is active.
        if let tint = ThemeStore.tabTints[tab] {
            return tint.opacity(0.85)
        }
        return Color.white.opacity(0.18)
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
