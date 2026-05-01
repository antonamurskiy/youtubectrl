import SwiftUI

private struct NPBarHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct RootView: View {
    @Environment(ServiceContainer.self) private var services
    @Environment(PlaybackStore.self) private var playback
    @Environment(FeedStore.self) private var feed
    @Environment(TerminalStore.self) private var terminal
    @Environment(ThemeStore.self) private var theme
    @Environment(UIStore.self) private var ui
    @Environment(PhoneModeStore.self) private var phoneMode

    @State private var searchFocused = false
    @State private var npBarHeight: CGFloat = 0

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

            // Phone-sync / phone-only video frame, hosting AVPlayerHost.containerView.
            if phoneMode.mode == .sync || phoneMode.mode == .phoneOnly {
                VStack(spacing: 0) {
                    GeometryReader { geo in
                        PhonePlayerView(host: services.avHost)
                            .frame(width: geo.size.width, height: geo.size.width * 9 / 16)
                    }
                    .frame(height: UIScreen.main.bounds.width * 9 / 16)
                    Spacer(minLength: 0)
                }
                .padding(.top, 70)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .zIndex(5)
            }

            // Now-playing bar — hidden when terminal+keyboard.
            if playback.playing && !(terminal.open && terminal.keyboardOpen) {
                NowPlayingBar()
                    .background(GeometryReader { geo in
                        Color.clear.preference(key: NPBarHeightKey.self, value: geo.size.height)
                    })
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(10)
            }

            // FAB stack (terminal toggle + refresh). Bottom padding tracks
            // whether NP bar is mounted + whether keyboard is up.
            // - keyboard up: lift to 408 (bar of soft keyboard ≈ 336 +
            //   ~72 clearance) — matches React's body.keyboard-open rule
            // - NP bar visible: ~250 (bar with three rows + safe area)
            // - otherwise: 24 from bottom
            FABStack()
                .padding(.trailing, 16)
                .padding(.bottom, fabBottomPadding)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                .ignoresSafeArea(.keyboard, edges: .bottom)
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
            if ui.commentsOpen {
                CommentsPanel()
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(41)
            }
            if ui.qualityMenuOpen {
                ZStack {
                    Color.black.opacity(0.4).ignoresSafeArea()
                        .onTapGesture { ui.qualityMenuOpen = false }
                    QualityMenu()
                }
                .transition(.opacity)
                .zIndex(42)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: ui.secretMenuOpen)
        .animation(.easeInOut(duration: 0.4), value: theme.resolvedSurface)
        .onPreferenceChange(NPBarHeightKey.self) { npBarHeight = $0 }
        .onChange(of: feed.activeTab) { _, new in theme.setTabTint(for: new) }
        .onChange(of: terminal.open) { _, new in theme.terminalOpen = new }
        .task { theme.setTabTint(for: feed.activeTab) }
    }

    private var fabBottomPadding: CGFloat {
        // Keyboard wins — use the system-reported keyboard height + 24
        // clearance + safe-area inset (the .ignoresSafeArea(.keyboard)
        // below means the parent's bottom inset is the home indicator's,
        // not the keyboard's).
        if terminal.keyboardOpen {
            return terminal.keyboardHeight + 24
        }
        if terminal.open { return 24 }                // terminal closed-keyboard: clear of home indicator
        if playback.playing && npBarHeight > 0 {
            return npBarHeight + 30
        }
        if playback.playing { return 290 }
        return 70
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
