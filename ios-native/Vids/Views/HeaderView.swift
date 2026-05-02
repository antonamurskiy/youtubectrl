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
        let font = UIFont.systemFont(ofSize: Self.pillFont, weight: .semibold)
        let segApp = UISegmentedControl.appearance()
        segApp.setTitleTextAttributes(
            [.font: font, .foregroundColor: UIColor.systemGray], for: .normal
        )
        segApp.setTitleTextAttributes(
            [.font: font, .foregroundColor: UIColor.white], for: .selected
        )
        // .backgroundColor alone leaves UISegmentedControl's native
        // background IMAGE drawing the dark bar behind all segments
        // (the "second container" inside our glass capsule). Replace
        // both the bar background AND the dividers with empty UIImage
        // so only the selected-segment pill shows.
        let empty = UIImage()
        segApp.setBackgroundImage(empty, for: .normal, barMetrics: .default)
        segApp.setBackgroundImage(empty, for: .selected, barMetrics: .default)
        segApp.setBackgroundImage(empty, for: .highlighted, barMetrics: .default)
        segApp.setDividerImage(empty,
                               forLeftSegmentState: .normal,
                               rightSegmentState: .normal,
                               barMetrics: .default)
        segApp.backgroundColor = .clear
        segApp.selectedSegmentTintColor = UIColor.white.withAlphaComponent(0.18)
    }

    var body: some View {
        GlassEffectContainer(spacing: 6) {
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
                        // Smallest pill — let the tabs Picker claim
                        // the leftover width since they need room
                        // for all the labels.
                        .frame(width: 60, alignment: .leading)
                }
                .padding(.horizontal, 18)
                .frame(height: Self.pillHeight)
                .glassEffect(.regular.tint(pillTint).interactive(), in: Capsule())
                .clipShape(Capsule())

                // Pill 2: native segmented Picker wrapped in the
                // same glass capsule chrome as pill 1 (search) and
                // pill 3 (dots).
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
                // Pin Picker height directly — clearing UISegmentedControl's
                // backgroundImage erased its intrinsic content size,
                // so SwiftUI expanded it to fill the screen.
                .frame(height: 32)
                .padding(.horizontal, 6)
                .frame(maxWidth: .infinity, minHeight: Self.pillHeight, maxHeight: Self.pillHeight)
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
