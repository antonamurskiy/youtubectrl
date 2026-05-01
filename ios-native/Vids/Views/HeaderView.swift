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
                Haptics.select()
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
                Haptics.success()
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
        // GlassEffectContainer lets the active tab pill morph through
        // glass between tabs — same Liquid Glass union that Apple uses
        // on the iOS 26 Camera mode picker.
        GlassEffectContainer(spacing: 2) {
            HStack(spacing: 2) {
                ForEach(FeedTab.allCases) { tab in
                    let active = activeTab == tab
                    Button(action: { onTap(tab) }) {
                        Text(tab.label)
                            .font(Font.app(10))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 4)
                            .foregroundStyle(active ? Color.appText : Color.appText.opacity(0.5))
                    }
                    .buttonStyle(.plain)
                    .modifier(ActiveTabGlass(active: active, ns: ns, id: tab.label))
                }
            }
            .fixedSize()
        }
        .animation(.spring(response: 0.32, dampingFraction: 0.85), value: activeTab)
    }
}

/// Apply the Liquid Glass pill only to the active tab — `glassEffectID`
/// lets the pill morph between tabs as the active one changes.
private struct ActiveTabGlass: ViewModifier {
    let active: Bool
    let ns: Namespace.ID
    let id: String
    func body(content: Content) -> some View {
        if active {
            content
                .glassEffect(.regular.tint(Color.appText.opacity(0.18)).interactive(),
                             in: Capsule())
                .glassEffectID(id, in: ns)
        } else {
            content
        }
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
