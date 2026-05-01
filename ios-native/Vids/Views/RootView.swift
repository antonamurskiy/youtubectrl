import SwiftUI

struct RootView: View {
    @Environment(ServiceContainer.self) private var services
    @Environment(PlaybackStore.self) private var playback
    @Environment(FeedStore.self) private var feed
    @Environment(TerminalStore.self) private var terminal
    @Environment(ThemeStore.self) private var theme
    @Environment(UIStore.self) private var ui
    @Environment(PhoneModeStore.self) private var phoneMode

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

            // Phone-sync video frame, hosting AVPlayerHost.containerView.
            if phoneMode.mode == .sync {
                PhonePlayerView(host: services.avHost)
                    .aspectRatio(16.0/9.0, contentMode: .fit)
                    .frame(maxWidth: .infinity, alignment: .top)
                    .padding(.top, 70)
                    .zIndex(5)
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

            ToastHUD().zIndex(30)
            VolumeHUD().zIndex(31)
            ClaudeFeedView().zIndex(25)

            if ui.secretMenuOpen {
                SecretMenu()
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(40)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: ui.secretMenuOpen)
        .animation(.easeInOut(duration: 0.4), value: theme.resolvedSurface)
        .onChange(of: feed.activeTab) { _, new in theme.setTabTint(for: new) }
        .onChange(of: terminal.open) { _, new in theme.terminalOpen = new }
        .task { theme.setTabTint(for: feed.activeTab) }
    }

    private var feedView: some View {
        VStack(spacing: 0) {
            HeaderView(searchFocused: $searchFocused)
            ZStack(alignment: .top) {
                FeedListView()
                if feed.currentVideos.isEmpty {
                    VStack(spacing: 6) {
                        Text(feed.lastError ?? "Loading…")
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.6))
                            .multilineTextAlignment(.center)
                            .lineLimit(6)
                            .padding(20)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 40)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
