import SwiftUI

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
private struct FeedTabContent: View {
    let tab: FeedTab
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services

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
                FeedListView(onSwipe: { _ in })
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
