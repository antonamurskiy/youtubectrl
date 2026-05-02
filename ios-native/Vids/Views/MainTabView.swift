import SwiftUI
import UIKit

/// Bottom-nav tab bar (iOS 26 UITabBar via SwiftUI TabView). This is
/// what gets the OS-owned Liquid Glass capsule + lift-out magnify
/// lens for free — same primitive Slack and Apple Music use. The
/// `Tab(role: .search)` renders as the detached circular search
/// button to the right of the capsule.
///
/// Each feed-tab body is the existing FeedListView. Selection drives
/// `feed.activeTab` so the rest of the app (theming, header tints,
/// load logic) keeps working unchanged.
struct MainTabView: View {
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services
    @Environment(PlaybackStore.self) private var playback
    @Environment(TerminalStore.self) private var terminal

    @State private var selection: TabKey = .rec
    @State private var searchText: String = ""
    @State private var searchTask: Task<Void, Never>? = nil

    enum TabKey: Hashable {
        case feed(FeedTab)
        case search

        static let rec: TabKey = .feed(.rec)
    }

    var body: some View {
        TabView(selection: $selection) {
            ForEach(FeedTab.allCases) { tab in
                Tab(tab.label, systemImage: icon(for: tab), value: TabKey.feed(tab)) {
                    FeedTabContent(tab: tab)
                        // Invisible attacher that finds the parent
                        // UITabBarController and sets `tabBarItem.menu`
                        // on every tab — including the system-generated
                        // More overflow. Long-press / Haptic Touch on
                        // any tab button then shows a quick-jump menu.
                        // SwiftUI's `.contextMenu` on `Tab` doesn't
                        // propagate to the bottom-bar buttons in iOS 26;
                        // UIKit's `UITabBarItem.menu` does.
                        .background(TabBarMenuAttacher(buildMenu: makeQuickJumpMenu))
                }
            }

            // Detached search button — iOS 26 renders Tab(role: .search)
            // as a circle next to the capsule.
            Tab(value: TabKey.search, role: .search) {
                SearchTabContent(searchText: $searchText)
            }
        }
        .tint(Color.appText)
        .searchable(text: $searchText, prompt: "Search YouTube")
        // Prevent the soft keyboard from shifting the bottom TabView
        // and feed cells up. iOS would otherwise push everything to
        // make room for the keyboard.
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .onChange(of: searchText) { _, new in
            searchTask?.cancel()
            searchTask = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 350_000_000)
                guard !Task.isCancelled else { return }
                await feed.search(new, api: services.api)
            }
        }
        .onChange(of: selection) { _, new in
            if case .feed(let tab) = new, feed.activeTab != tab {
                Haptics.select()
                feed.activeTab = tab
                Task { await feed.load(tab: tab, api: services.api) }
            }
        }
        // Always launch on Rec, regardless of last-session persisted
        // activeTab. The previous behavior (sync to feed.activeTab)
        // surprised the user with red/green/etc. bg on launch when
        // they'd left off on a tinted tab. Force feed.activeTab back
        // to .rec so the theme tint matches the visible tab.
        .task {
            if feed.activeTab != .rec {
                feed.activeTab = .rec
            }
            selection = .feed(.rec)
            if feed.currentVideos.isEmpty {
                await feed.load(tab: .rec, api: services.api)
            }
        }
        // NowPlayingBar is NOT placed in .tabViewBottomAccessory —
        // that slot expects a small mini-player pill (Apple Music
        // collapsed style), and our NPBar is a full multi-row
        // control surface. Instead it overlays in RootView, padded
        // above the tab bar.
    }

    private func icon(for tab: FeedTab) -> String {
        switch tab {
        case .rec:     return "sparkles"
        case .live:    return "dot.radiowaves.left.and.right"
        case .subs:    return "play.rectangle.on.rectangle"
        case .ru:      return "globe"
        case .history: return "clock.arrow.circlepath"
        }
    }
}

/// Single feed tab body — wraps FeedListView with the channel-filter
/// banner that used to live in RootView.feedView. Triggers an
/// on-appear load for its own tab if the bucket is empty so each tab
/// is responsible for its own data, not blocked on activeTab races.
extension MainTabView {
    /// Build a UIMenu of every FeedTab as a quick-jump shortcut. Used
    /// by both the standard tabs AND the system-generated More button.
    func makeQuickJumpMenu() -> UIMenu {
        let actions: [UIAction] = FeedTab.allCases.map { tab in
            UIAction(title: tab.label, image: UIImage(systemName: icon(for: tab))) { _ in
                Haptics.select()
                selection = .feed(tab)
            }
        }
        return UIMenu(title: "Jump to", children: actions)
    }
}

/// Walks up from its hosted UIView at `didMoveToWindow` time, finds
/// the parent UITabBarController's UITabBar, and adds a
/// UIContextMenuInteraction on each tab-button subview so long-press /
/// Haptic Touch on a tab button shows a quick-jump menu. Catches the
/// system-generated More overflow button automatically because UITabBar
/// renders it as another UIControl in the same subview tree.
///
/// `UITabBarItem` itself has no `menu` property — it's just a model
/// object with title/image. The interactive surface is an internal
/// `UITabBarButton` (UIControl subclass), which IS interaction-friendly.
private struct TabBarMenuAttacher: UIViewRepresentable {
    let buildMenu: () -> UIMenu

    func makeCoordinator() -> Coordinator {
        Coordinator(buildMenu: buildMenu)
    }

    func makeUIView(context: Context) -> AttacherView {
        let v = AttacherView()
        v.coordinator = context.coordinator
        return v
    }

    func updateUIView(_ uiView: AttacherView, context: Context) {
        context.coordinator.buildMenu = buildMenu
        uiView.applyIfPossible()
    }

    final class Coordinator: NSObject, UIContextMenuInteractionDelegate {
        var buildMenu: () -> UIMenu
        // Invisible 1pt preview view, sized + positioned at the
        // touch location. Returned to UIKit as the targeted preview
        // so the system animates THIS instead of lifting the whole
        // UITabBar (which is what made every icon jump up when the
        // menu appeared).
        private weak var previewHost: UIView?
        private var previewDummy: UIView?

        init(buildMenu: @escaping () -> UIMenu) { self.buildMenu = buildMenu }

        func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                    configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
            // Stash the host + a 1pt clear "anchor" at the touch
            // location so the highlight + dismiss callbacks can return
            // the same UITargetedPreview.
            if let host = interaction.view {
                previewHost = host
                let dummy = UIView(frame: CGRect(x: location.x, y: location.y, width: 1, height: 1))
                dummy.backgroundColor = .clear
                dummy.isUserInteractionEnabled = false
                host.addSubview(dummy)
                previewDummy = dummy
            }
            return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
                self?.buildMenu()
            }
        }

        func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                    previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
            invisibleTarget(for: interaction)
        }

        func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                    previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
            invisibleTarget(for: interaction)
        }

        func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                    willEndFor configuration: UIContextMenuConfiguration,
                                    animator: (any UIContextMenuInteractionAnimating)?) {
            // Clean up the dummy after the menu animation finishes so
            // we don't leak invisible 1pt subviews on every long press.
            animator?.addCompletion { [weak self] in
                self?.previewDummy?.removeFromSuperview()
                self?.previewDummy = nil
            }
        }

        private func invisibleTarget(for interaction: UIContextMenuInteraction) -> UITargetedPreview? {
            guard let dummy = previewDummy, let host = previewHost else { return nil }
            let params = UIPreviewParameters()
            params.backgroundColor = .clear
            params.shadowPath = UIBezierPath()
            return UITargetedPreview(view: dummy, parameters: params,
                                     target: UIPreviewTarget(container: host, center: dummy.center))
        }
    }

    final class AttacherView: UIView {
        weak var coordinator: Coordinator?
        private weak var attachedTabBar: UITabBar?
        private var attachedButtons: [ObjectIdentifier] = []

        override func didMoveToWindow() {
            super.didMoveToWindow()
            DispatchQueue.main.async { [weak self] in
                self?.applyIfPossible()
            }
        }

        func applyIfPossible() {
            guard let coord = coordinator else { return }
            guard let tbc = findTabBarController() else { return }
            let bar = tbc.tabBar
            if attachedTabBar === bar { return }
            attachedTabBar = bar
            // Single UIContextMenuInteraction on the tab bar itself.
            // The delegate's `configurationForMenuAtLocation` is given
            // the long-press location; we always show the same quick-
            // jump menu. This avoids fighting with private UIKit
            // gestures on internal tab-button subviews.
            let interaction = UIContextMenuInteraction(delegate: coord)
            bar.addInteraction(interaction)
        }

        private func findTabBarController() -> UITabBarController? {
            var responder: UIResponder? = self
            while let r = responder {
                if let tbc = r as? UITabBarController { return tbc }
                if let vc = r as? UIViewController, let tbc = vc.tabBarController { return tbc }
                responder = r.next
            }
            return nil
        }
    }
}

private struct FeedTabContent: View {
    let tab: FeedTab
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services

    /// Background tint per tab. Mirrors React's TAB_TINTS map. The
    /// global ThemeStore.resolvedSurface only paints RootView's
    /// outer ZStack — TabView's opaque content covers it, so the
    /// tint never reached the user's eye until we painted it inside
    /// each tab's own body.
    private var tabSurface: Color {
        if let t = ThemeStore.tabTints[tab] {
            return t.darken(0.55)
        }
        return Color(hex: "#282828")
    }

    var body: some View {
        VStack(spacing: 0) {
            if let ch = feed.channelQuery {
                HStack(spacing: 8) {
                    Image(systemName: "person.crop.rectangle")
                    Text("Viewing: \(ch)")
                        .font(Font.app(13, weight: .semibold))
                    Spacer()
                    Button {
                        feed.clearChannel()
                        Task { await feed.load(tab: feed.activeTab, api: services.api) }
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.plain)
                }
                .foregroundStyle(Color.appText)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Color.appText.opacity(0.06))
            }
            ZStack(alignment: .top) {
                FeedListView(tab: tab, onSwipe: { _ in })
                    .ignoresSafeArea(.container, edges: [.top, .bottom])
                    .scrollEdgeEffectStyle(nil, for: .top)
                if feed.currentVideos.isEmpty {
                    if let err = feed.lastError {
                        Text(err)
                            .font(Font.app(12))
                            .foregroundStyle(Color.appText.opacity(0.6))
                            .multilineTextAlignment(.center)
                            .lineLimit(6)
                            .padding(20)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 40)
                    } else {
                        FeedSkeleton()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(tabSurface.ignoresSafeArea())
        .animation(.timingCurve(0.25, 0.1, 0.25, 1.0, duration: 0.4), value: tabSurface)
        .task(id: tab) {
            // Load this tab's own data on first appear if not already
            // loaded. Decouples per-tab loading from the activeTab
            // sync race.
            if (feed.videosForTab(tab).isEmpty) {
                await feed.load(tab: tab, api: services.api)
            }
        }
    }
}

/// Search tab body — the system .searchable bar handles input; we
/// render the resulting feed of videos beneath.
private struct SearchTabContent: View {
    @Binding var searchText: String
    @Environment(FeedStore.self) private var feed

    var body: some View {
        ZStack(alignment: .top) {
            FeedListView(onSwipe: { _ in })
                .ignoresSafeArea(.container, edges: [.top, .bottom])
                .scrollEdgeEffectStyle(nil, for: .top)
            if feed.currentVideos.isEmpty {
                Text(searchText.isEmpty ? "Type to search" : "No results")
                    .font(Font.app(12))
                    .foregroundStyle(Color.appText.opacity(0.6))
                    .padding(.top, 80)
            }
        }
    }
}
