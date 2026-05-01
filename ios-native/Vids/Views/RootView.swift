import SwiftUI

struct RootView: View {
    @Environment(ServiceContainer.self) private var services
    @Environment(PlaybackStore.self) private var playback
    @Environment(FeedStore.self) private var feed
    @Environment(TerminalStore.self) private var terminal
    @Environment(ThemeStore.self) private var theme

    @State private var searchFocused = false

    var body: some View {
        ZStack(alignment: .bottom) {
            theme.resolvedSurface.ignoresSafeArea()

            // Feed dismounts entirely when terminal opens.
            if !terminal.open {
                feedView
                    .transition(.identity)
            }

            // Terminal slides up from bottom.
            if terminal.open {
                TerminalView()
                    .transition(.identity)
            }

            // Now-playing bar — hidden when terminal+keyboard.
            if playback.playing && !(terminal.open && terminal.keyboardOpen) {
                NowPlayingBar()
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(10)
            }

            // FAB stack (cmux + refresh).
            FABStack()
                .padding(.trailing, 16)
                .padding(.bottom, playback.playing ? 240 : 24)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                .allowsHitTesting(true)
                .zIndex(20)
        }
        .animation(.easeInOut(duration: 0.4), value: theme.resolvedSurface)
        .onChange(of: feed.activeTab) { _, new in theme.setTabTint(for: new) }
        .onChange(of: terminal.open) { _, new in theme.terminalOpen = new }
        .task { theme.setTabTint(for: feed.activeTab) }
    }

    private var feedView: some View {
        VStack(spacing: 0) {
            HeaderView(searchFocused: $searchFocused)
            FeedListView()
        }
    }
}
