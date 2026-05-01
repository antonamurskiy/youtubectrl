import SwiftUI

struct HeaderView: View {
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services
    @Environment(PlaybackStore.self) private var playback
    @Environment(ThemeStore.self) private var theme
    @Binding var searchFocused: Bool
    @State private var searchText: String = ""
    @State private var searchTask: Task<Void, Never>? = nil
    @FocusState private var fieldFocus: Bool

    var body: some View {
        // Single row: home / search / tabs / status dots — matches React.
        HStack(spacing: 6) {
            Button(action: home) {
                Image(systemName: "play.fill")
                    .font(Font.app(13, weight: .bold))
                    .foregroundStyle(Color.appText.opacity(0.85))
                    .frame(width: 24, height: 24)
            }

            TextField("Search", text: $searchText)
                .textFieldStyle(.plain)
                .submitLabel(.search)
                .foregroundStyle(Color.appText)
                .tint(.white)
                .focused($fieldFocus)
                .contentShape(Rectangle())
                .onTapGesture { fieldFocus = true }
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
                .frame(maxWidth: .infinity, minHeight: 26)
                .padding(.vertical, 4)

            // Inline tabs — pill smoothly slides via matchedGeometryEffect.
            TabsRow(activeTab: feed.activeTab) { tab in
                feed.activeTab = tab
                Task { await feed.load(tab: tab, api: services.api) }
            }

            HStack(spacing: 3) {
                StatusDot(on: true)
                StatusDot(on: playback.macStatus.ethernet ?? false)
                StatusDot(on: !(playback.macStatus.locked ?? false))
                StatusDot(on: !(playback.macStatus.screenOff ?? false))
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 4)
            .onLongPressGesture(minimumDuration: 0.5) {
                services.ui.secretMenuOpen = true
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }

    private func home() {
        feed.activeTab = .rec
        searchText = ""
        fieldFocus = false
        Task { await feed.load(tab: .rec, api: services.api) }
    }
}

private struct TabsRow: View {
    let activeTab: FeedTab
    let onTap: (FeedTab) -> Void
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 2) {
            ForEach(FeedTab.allCases) { tab in
                let active = activeTab == tab
                Button(action: { onTap(tab) }) {
                    Text(tab.label)
                        .font(Font.app(10))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 3)
                        .foregroundStyle(active ? Color.appText : Color.white.opacity(0.45))
                        .background(
                            ZStack {
                                if active {
                                    Color.white.opacity(0.22)
                                        .matchedGeometryEffect(id: "tab.bg", in: ns)
                                }
                            }
                        )
                        .overlay(alignment: .bottom) {
                            ZStack {
                                if active {
                                    Color(hex: "#ebdbb2")
                                        .frame(height: 1.5)
                                        .matchedGeometryEffect(id: "tab.underline", in: ns)
                                }
                            }
                            .frame(height: 1.5)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 2))
                }
                .buttonStyle(.plain)
            }
        }
        .fixedSize()
        .animation(.spring(response: 0.32, dampingFraction: 0.85), value: activeTab)
    }
}

private struct StatusDot: View {
    let on: Bool
    @State private var pulse: Bool = false
    var body: some View {
        Circle()
            .fill(on ? Color(hex: "#8ec07c") : Color(hex: "#3c3836"))
            .frame(width: 5, height: 5)
            .scaleEffect(pulse ? 1.6 : 1)
            .opacity(pulse ? 0.4 : 1)
            .animation(.easeOut(duration: 0.45), value: pulse)
            .onChange(of: on) { _, _ in
                pulse = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { pulse = false }
            }
    }
}
