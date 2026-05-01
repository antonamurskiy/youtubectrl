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
    @Environment(FontStore.self) private var fonts

    @State private var searchFocused = false
    @State private var npBarHeight: CGFloat = 0

    var body: some View {
        // Read fonts.generation here so a font load/change triggers a
        // re-render of the entire subtree.
        let _ = fonts.generation
        // Inject the chosen font as the default so Text/Label without
        // an explicit .font modifier (TextField placeholder, default
        // Text in subviews) inherit it instead of SF Pro.
        rootBody
            .font(Font.app(fonts.size))
    }

    private var rootBody: some View {
        ZStack(alignment: .bottom) {
            theme.resolvedSurface.ignoresSafeArea()
            // Hardware keyboard shortcuts — space play/pause, ←/→ skip 5s.
            // Capture-phase + global focus so they fire whether or not a
            // text field has focus (which is rarely true on iPhone).
            Color.clear.frame(width: 0, height: 0)
                .focusable()
                .onKeyPress(.space) {
                    Task { try? await services.api.playPause() }
                    return .handled
                }
                .onKeyPress(.leftArrow) {
                    Task { try? await services.api.skip(-5) }
                    return .handled
                }
                .onKeyPress(.rightArrow) {
                    Task { try? await services.api.skip(5) }
                    return .handled
                }

            // Feed always mounted — preserves scroll position across
            // terminal toggles. Hidden via opacity (not removal) so
            // SwiftUI doesn't re-create the UICollectionView.
            feedView
                .opacity(terminal.open ? 0 : 1)
                .allowsHitTesting(!terminal.open)

            // Terminal cross-fades over the feed.
            if terminal.open {
                TerminalView()
                    .transition(.opacity)
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
            VStack {
                Spacer()
                HStack {
                    Spacer()
                    FABStack()
                        .padding(.trailing, 16)
                        .padding(.bottom, fabBottomPadding)
                        // Disable any animation inherited from parent.
                        // Parent has .animation(.easeOut, value: terminal.open)
                        // and .animation(.easeInOut, value: theme.resolvedSurface)
                        // which were animating FAB position on unrelated
                        // state changes — looked like the FABs were
                        // bouncing for no reason.
                        .transaction { $0.animation = nil }
                }
            }
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
            if ui.audioSheetOpen {
                ZStack {
                    Color.black.opacity(0.4).ignoresSafeArea()
                        .onTapGesture { ui.audioSheetOpen = false }
                    AudioOutputSheet()
                }
                .transition(.opacity)
                .zIndex(43)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: ui.secretMenuOpen)
        // Match the SwiftTerm CADisplayLink curve EXACTLY — both
        // use cubic-bezier(0.25, 0.1, 0.25, 1.0) over 0.4s so body bg,
        // FAB, scrubber, np-bar, and the terminal pane traverse the
        // same color path at the same rate (CLAUDE.md > "Synchronizing
        // the tint fade").
        .animation(.timingCurve(0.25, 0.1, 0.25, 1.0, duration: 0.4), value: theme.resolvedSurface)
        .animation(.easeOut(duration: 0.25), value: terminal.open)
        .onPreferenceChange(NPBarHeightKey.self) { npBarHeight = $0 }
        .onChange(of: feed.activeTab) { _, new in theme.setTabTint(for: new) }
        .onChange(of: terminal.open) { _, new in theme.terminalOpen = new }
        .onChange(of: terminal.activeWindow?.name ?? "") { _, _ in
            // When the active tmux window changes, paint the body bg
            // with that window's color so the whole app shifts to
            // match the pane you're working in.
            if let name = terminal.activeWindow?.name,
               let hex = terminal.resolveColor(name) {
                theme.activeTmuxTint = Color(hex: hex)
            } else {
                theme.activeTmuxTint = nil
            }
        }
        .onChange(of: terminal.colors) { _, _ in
            // Color picker commit also updates the active tint live.
            if let name = terminal.activeWindow?.name,
               let hex = terminal.resolveColor(name) {
                theme.activeTmuxTint = Color(hex: hex)
            }
        }
        .onChange(of: playback.playing) { _, new in
            // Hardware volume buttons drive the Mac whenever something
            // is playing on it, regardless of phone mode (matches React).
            if new { services.avHost.enableVolumeIntercept() }
            else { services.avHost.disableVolumeIntercept() }
        }
        .onChange(of: playback.url) { _, _ in
            // When mpv switches videos while sync mode is active, reload
            // the AVPlayer with the new URL — otherwise PiP keeps showing
            // the previous content's last frame.
            Task { await phoneMode.reloadForCurrentVideo(services: services) }
        }
        .task { theme.setTabTint(for: feed.activeTab) }
    }

    private var fabBottomPadding: CGFloat {
        // FABs only move based on whether keyboard is up. Terminal
        // toggle alone (with keyboard down) shouldn't shift them.
        if terminal.keyboardOpen {
            return terminal.keyboardHeight + 16
        }
        // Just above the now-playing bar (~200pt rendered) when
        // playing, otherwise just above the home indicator.
        return playback.playing ? 210 : 32
    }

    private var feedView: some View {
        VStack(spacing: 0) {
            HeaderView(searchFocused: $searchFocused)
            if let ch = feed.channelQuery {
                HStack(spacing: 8) {
                    Image(systemName: "person.crop.rectangle")
                    Text("Viewing: \(ch)")
                        .font(Font.app(13, weight: .semibold))
                    Spacer()
                    Button(action: {
                        feed.clearChannel()
                        Task { await feed.load(tab: feed.activeTab, api: services.api) }
                    }) {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.plain)
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.white.opacity(0.06))
            }
            ZStack(alignment: .top) {
                FeedListView()
                if feed.currentVideos.isEmpty {
                    VStack(spacing: 6) {
                        Text(feed.lastError ?? "Loading…")
                            .font(Font.app(12, design: .monospaced))
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
