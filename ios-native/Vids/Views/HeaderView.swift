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

    /// Uniform font size across the three nav pills — pill height is
    /// derived from content (font + vertical padding) so type-size
    /// changes don't fight a hardcoded frame.
    private static let pillFont: CGFloat = 13
    private static let pillHeight: CGFloat = 44

    init(searchFocused: Binding<Bool>) {
        self._searchFocused = searchFocused
        // Match the segmented Picker's title font to the other pills.
        // DON'T touch backgroundImage / selectedSegmentTintColor —
        // those carry iOS 26's Liquid Glass chrome and the magnify
        // lensing on the selected pill. Overriding them kills both.
        let font = UIFont.systemFont(ofSize: Self.pillFont, weight: .semibold)
        let segApp = UISegmentedControl.appearance()
        segApp.setTitleTextAttributes([.font: font], for: .normal)
        segApp.setTitleTextAttributes([.font: font], for: .selected)
    }

    var body: some View {
        GlassEffectContainer(spacing: 6) {
            HStack(spacing: 6) {
                // Pill 1: collapsed magnifier circle until tapped.
                // When expanded, becomes a TextField inside the same
                // glass capsule chrome.
                searchPill

                // Pill 2: native segmented Picker — keeps iOS 26
                // Liquid Glass + drag-to-switch + magnify lensing
                // intact (don't wrap in another glass capsule, that
                // produces the "double container" look).
                Picker("Tab", selection: Binding(
                    get: { feed.activeTab },
                    set: { newTab in
                        Haptics.select()
                        feed.activeTab = newTab
                        Task { await feed.load(tab: newTab, api: services.api) }
                    }
                )) {
                    ForEach(FeedTab.allCases) { tab in
                        Text(tab.label).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal, 4)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .frame(height: Self.pillHeight)
                // Same outer glass capsule as the search + dots pills.
                // Segmented control's own iOS 26 Liquid Glass + magnifier
                // renders inside it — the small inner-bar artifact is
                // unavoidable since clearing it kills the magnifier.
                .glassEffect(.regular.tint(pillTint).interactive(), in: Capsule())
                .clipShape(Capsule())

                // Pill 3: status dots → secret menu
                HStack(spacing: 4) {
                    StatusDot(on: true)
                    StatusDot(on: playback.macStatus.ethernet ?? false)
                    StatusDot(on: !(playback.macStatus.locked ?? false))
                    StatusDot(on: !(playback.macStatus.screenOff ?? false))
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .contentShape(Capsule())
                .glassEffect(.regular.tint(pillTint).interactive(), in: Capsule())
                .clipShape(Capsule())
                .onLongPressGesture(minimumDuration: 0.5) {
                    Haptics.success()
                    services.ui.secretMenuOpen = true
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 4)
    }

    @ViewBuilder
    private var searchPill: some View {
        if fieldFocus || !searchText.isEmpty {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: Self.pillFont, weight: .semibold))
                    .foregroundStyle(Color.appText.opacity(0.55))
                TextField("Search", text: $searchText)
                    .textFieldStyle(.plain)
                    .submitLabel(.search)
                    .font(Font.app(Self.pillFont))
                    .foregroundStyle(Color.appText)
                    .tint(.white)
                    .focused($fieldFocus)
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
                    .frame(minWidth: 80, alignment: .leading)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                        fieldFocus = false
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Color.appText.opacity(0.4))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
            .frame(height: Self.pillHeight)
            .glassEffect(.regular.tint(pillTint).interactive(), in: Capsule())
            .clipShape(Capsule())
        } else {
            Button {
                fieldFocus = true
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: Self.pillFont + 2, weight: .semibold))
                    .foregroundStyle(Color.appText)
                    .frame(width: Self.pillHeight, height: Self.pillHeight)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.tint(pillTint).interactive(), in: Circle())
            .clipShape(Circle())
        }
    }

    private func home() {
        feed.activeTab = .rec
        searchText = ""
        fieldFocus = false
        Task { await feed.load(tab: .rec, api: services.api) }
    }
}

// TabsRow + helpers removed — using native Picker(.segmented) which
// gets iOS 26 Liquid Glass + drag-to-switch + magnify-under-finger
// for free. There's no public API to recreate the camera-style
// lensing on a custom view (per WWDC25 session 323).

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
