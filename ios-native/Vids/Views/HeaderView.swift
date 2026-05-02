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

    /// Theme-aware tint mirroring the NPBar's barTint logic.
    private var pillTint: Color {
        if let r = theme.resolved {
            return r.darken(0.55).opacity(0.7)
        }
        return Color(red: 40/255, green: 40/255, blue: 40/255).opacity(0.7)
    }

    /// Uniform pill metrics so all three nav capsules render the same
    /// height and content type size.
    private static let pillHeight: CGFloat = 36
    private static let pillFont: CGFloat = 12

    var body: some View {
        Group {
            HStack(spacing: 6) {
                // Pill 1: search
                HStack(spacing: 0) {
                    TextField("Search", text: $searchText)
                        .textFieldStyle(.plain)
                        .submitLabel(.search)
                        .font(Font.app(Self.pillFont))
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
                        // Expand to fill all remaining width — header
                        // is right-aligned in RootView, so the search
                        // pill stretches leftward to claim free space.
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 12)
                .frame(height: Self.pillHeight)
                .background(pillTint, in: Capsule())

                // Pill 2: tabs — active highlight follows the theme.
                TabsRow(activeTab: feed.activeTab,
                        fontSize: Self.pillFont,
                        highlightTint: theme.resolved ?? Color.appText) { tab in
                    Haptics.select()
                    feed.activeTab = tab
                    Task { await feed.load(tab: tab, api: services.api) }
                }
                .padding(.horizontal, 6)
                .frame(height: Self.pillHeight)
                .background(pillTint, in: Capsule())

                // Pill 3: status dots → secret menu
                HStack(spacing: 4) {
                    StatusDot(on: true)
                    StatusDot(on: playback.macStatus.ethernet ?? false)
                    StatusDot(on: !(playback.macStatus.locked ?? false))
                    StatusDot(on: !(playback.macStatus.screenOff ?? false))
                }
                .padding(.horizontal, 14)
                .frame(height: Self.pillHeight)
                .contentShape(Capsule())
                .background(pillTint, in: Capsule())
                .onLongPressGesture(minimumDuration: 0.5) {
                    Haptics.success()
                    services.ui.secretMenuOpen = true
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 4)
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
    let fontSize: CGFloat
    let highlightTint: Color
    let onTap: (FeedTab) -> Void
    @Namespace private var ns

    var body: some View {
        // GlassEffectContainer lets the active tab pill morph through
        // glass between tabs — same Liquid Glass union that Apple uses
        // on the iOS 26 Camera mode picker.
        Group {
            HStack(spacing: 2) {
                ForEach(FeedTab.allCases) { tab in
                    let active = activeTab == tab
                    Button(action: { onTap(tab) }) {
                        Text(tab.label)
                            .font(Font.app(fontSize, weight: .semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .foregroundStyle(active ? Color.appText : Color.appText.opacity(0.5))
                    }
                    .buttonStyle(.plain)
                    .modifier(ActiveTabGlass(active: active, tint: highlightTint, ns: ns, id: tab.label))
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
    let tint: Color
    let ns: Namespace.ID
    let id: String
    func body(content: Content) -> some View {
        if active {
            content
                // Active tab pill picks up the theme tint (tmux pane
                // color or per-tab tint) instead of a fixed cream wash.
                .background(tint.opacity(0.45), in: Capsule())
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
