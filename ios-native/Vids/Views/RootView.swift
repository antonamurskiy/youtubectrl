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

    @State private var npBarHeight: CGFloat = 0
    @State private var renamingTmux: TmuxWindow? = nil
    @State private var npBarFrame: CGRect = .zero
    @Environment(\.horizontalSizeClass) private var hSize

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

            // iPad / landscape regular: feed and terminal side-by-side
            // (50/50 split). iPhone compact: cross-fade as before.
            // Feed area is now MainTabView — iOS 26 TabView with the
            // OS-owned Liquid Glass tab bar + lift-out lens. Search
            // is a Tab(role: .search) → detached circle. NowPlayingBar
            // lives inside .tabViewBottomAccessory.
            // NPBar is taller now (4 rows + scrubber + paddings). The
            // old 175 was too low → tmux content rendered behind the
            // bar's top edge, garbling the visible PTY rows.
            let bottomInset: CGFloat = (playback.playing && !terminal.keyboardOpen)
                ? 240
                : 0
            if hSize == .regular {
                HStack(spacing: 0) {
                    MainTabView()
                        .frame(maxWidth: .infinity)
                    TerminalView(bottomInset: bottomInset)
                        .frame(maxWidth: .infinity)
                        .opacity(terminal.open ? 1 : 0)
                        .allowsHitTesting(terminal.open)
                }
            } else {
                MainTabView()
                    .opacity(terminal.open ? 0 : 1)
                    .allowsHitTesting(!terminal.open)
                TerminalView(bottomInset: bottomInset)
                    .opacity(terminal.open ? 1 : 0)
                    .allowsHitTesting(terminal.open)
            }

            // Phone-sync / phone-only video frame, hosting AVPlayerHost.containerView.
            // Sized via GeometryReader from the parent so it adapts to
            // landscape + iPad regular size class.
            // Inline player frame; hidden via opacity (not unmounted)
            // when PiP is active so the AVPlayerLayer stays attached
            // and gating bugs can't accidentally keep it off-screen.
            if phoneMode.mode == .sync || phoneMode.mode == .phoneOnly {
                GeometryReader { outer in
                    let availW = outer.size.width
                    let availH = outer.size.height - 90  // header + safe area
                    let widthBound = availW * 9 / 16
                    let heightBound = availH
                    // Pick whichever 16:9 fit doesn't overflow.
                    let h: CGFloat = min(widthBound, heightBound)
                    let w: CGFloat = h * 16 / 9
                    VStack(spacing: 0) {
                        PhonePlayerView(host: services.avHost)
                            .frame(width: w, height: h)
                            .frame(maxWidth: .infinity)
                            // Hidden during PiP so the empty layer
                            // doesn't show a black box, but stays
                            // mounted so the AVPlayerLayer hierarchy
                            // is preserved.
                            .opacity(services.avHost.pipActive ? 0 : 1)
                        Spacer(minLength: 0)
                    }
                    .padding(.top, 70)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                // Above the top safe-area glass strip (zIndex 17) so
                // the inline player is never visually obscured by it.
                .zIndex(19)
            }

            // NowPlayingBar — sibling overlay just above the tab bar.
            // iOS 26 standard tab bar is ≈49pt + bottom safe area; we
            // pad NPBar's bottom by that. .tabViewBottomAccessory
            // rendered the bar tiny because that slot expects a
            // collapsed mini-player pill, not our full control bar.
            if playback.playing && !(terminal.open && terminal.keyboardOpen) {
                NowPlayingBar()
                    .frame(maxWidth: hSize == .regular ? 600 : .infinity)
                    .frame(maxWidth: .infinity)
                    .onGeometryChange(for: CGFloat.self) { proxy in
                        proxy.size.height
                    } action: { newValue in
                        npBarHeight = newValue
                    }
                    // Tab bar only renders in the feed pane, not the
                    // terminal pane. Drop the offset when terminal is
                    // open so NPBar sits flush at the bottom.
                    .padding(.bottom, terminal.open ? 0 : 56)
                    // .container so the bar can sit in the safe-area
                    // band — without this, SwiftUI shrinks the VStack
                    // and clips the scrubber + title rows out of view.
                    .ignoresSafeArea(.container, edges: .bottom)
                    .ignoresSafeArea(.keyboard, edges: .bottom)
                    .transition(.opacity)
                    .zIndex(10)
            }

            // FAB stack (terminal toggle + refresh). Bottom padding tracks
            // whether NP bar is mounted + whether keyboard is up.
            // - keyboard up: lift to 408 (bar of soft keyboard ≈ 336 +
            //   ~72 clearance) — matches React's body.keyboard-open rule
            // - NP bar visible: ~250 (bar with three rows + safe area)
            // - otherwise: 24 from bottom
            // FAB stack — full-screen frame with bottom-trailing
            // alignment. SwiftUI's hit testing only fires where the
            // FAB content is painted; empty padding region passes
            // through to the feed below.
            FABStack()
                .padding(.trailing, 16)
                .padding(.bottom, fabBottomPadding)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                .transaction { $0.animation = nil }
                .ignoresSafeArea(.keyboard, edges: .bottom)
                .zIndex(20)

            // Top-edge live blur strip — masks cells scrolling under
            // the Dynamic Island. Same shape we had before: hold full
            // opacity for ~35% of the strip, fade to clear so the
            // bottom edge is smooth.
            if !terminal.open {
                GeometryReader { proxy in
                    Rectangle()
                        .fill(.regularMaterial)
                        // Just enough to cover Dynamic Island + a small
                        // fringe; no over-extension into the feed.
                        .frame(height: proxy.safeAreaInsets.top + 12)
                        .mask(
                            // Pure linear top→bottom fade (no hold) so
                            // the transition is smooth all the way.
                            LinearGradient(
                                colors: [.black, .clear],
                                startPoint: .top, endPoint: .bottom
                            )
                        )
                        .ignoresSafeArea(.container, edges: .top)
                }
                .allowsHitTesting(false)
                .zIndex(17)

                StatusDotsPill()
                    .padding(.trailing, 16)
                    .padding(.top, 8)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .zIndex(18)
            }

            // Tmux tab strip — top-right, only when terminal is open.
            // Sibling at RootView level (not inside TerminalView) so
            // .ignoresSafeArea(.keyboard) actually pins it through
            // soft-keyboard show/hide. Per-window rename target lifts
            // up to RootView's renamingTmux state which TmuxTabStrip
            // writes via Binding.
            if terminal.open {
                TmuxTabStrip(renaming: $renamingTmux)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .ignoresSafeArea(.keyboard, edges: .all)
                    .zIndex(19)
            }

            ToastHUD().zIndex(30)
            VolumeHUD().zIndex(31)
            ClaudeFeedView().zIndex(25)
            ClaudeQuickReply().zIndex(28)
            // Sibling overlay so the floating tile lives ABOVE the
            // NPBar's glass clip — same layer pattern AVKit uses for
            // its scrub preview thumbnail.
            ScrubPreviewOverlay(barHeight: npBarHeight,
                                bottomOffset: terminal.open ? 0 : 56)
                .zIndex(15)
                .ignoresSafeArea()

        }
        .sheet(item: Binding(
            get: { renamingTmux },
            set: { renamingTmux = $0 }
        )) { w in
            TmuxRenamePopover(window: w, open: Binding(get: { renamingTmux != nil }, set: { if !$0 { renamingTmux = nil } }))
                .presentationDetents([.height(360)])
                .presentationDragIndicator(.visible)
                .presentationBackground(.regularMaterial)
        }
        .sheet(isPresented: Binding(
            get: { ui.secretMenuOpen },
            set: { ui.secretMenuOpen = $0 }
        )) {
            SecretMenu()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                // Dim backdrop behind the glass cards — without it the
                // cards float over the bright feed with nothing for the
                // glass tint to push against, looking flat.
                .presentationBackground {
                    Color.black.opacity(0.35).ignoresSafeArea()
                }
        }
        .sheet(isPresented: Binding(
            get: { ui.commentsOpen },
            set: { ui.commentsOpen = $0 }
        )) {
            CommentsPanel()
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .presentationBackground(.thinMaterial)
        }
        .sheet(isPresented: Binding(
            get: { ui.qualityMenuOpen },
            set: { ui.qualityMenuOpen = $0 }
        )) {
            QualityMenu()
                .presentationDetents([.height(320)])
                .presentationDragIndicator(.visible)
                .presentationBackground(.thinMaterial)
        }
        .sheet(isPresented: Binding(
            get: { ui.audioSheetOpen },
            set: { ui.audioSheetOpen = $0 }
        )) {
            AudioOutputSheet()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationBackground(.thinMaterial)
        }
        // Match the SwiftTerm CADisplayLink curve EXACTLY — both
        // use cubic-bezier(0.25, 0.1, 0.25, 1.0) over 0.4s so body bg,
        // FAB, scrubber, np-bar, and the terminal pane traverse the
        // same color path at the same rate (CLAUDE.md > "Synchronizing
        // the tint fade").
        .animation(.timingCurve(0.25, 0.1, 0.25, 1.0, duration: 0.4), value: theme.resolvedSurface)
        .animation(.easeOut(duration: 0.25), value: terminal.open)
        .coordinateSpace(name: "root")
        .onPreferenceChange(NPBarHeightKey.self) { npBarHeight = $0 }
        .onPreferenceChange(NPBarFrameKey.self) { npBarFrame = $0 }
        .onChange(of: feed.activeTab) { _, new in theme.setTabTint(for: new) }
        .onChange(of: terminal.open) { _, new in
            theme.terminalOpen = new
            // Persistent mount means SwiftTerm keeps first-responder
            // status across close. Dismiss the soft keyboard explicitly
            // so closing the panel always tucks it away.
            if !new { terminal.dismissKeyboard?() }
        }
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
            // Mac-side hardware volume control is only useful when the
            // Mac is actually the audible source. In phone-only the
            // user expects AirPods volume buttons to work natively, so
            // skip the intercept.
            if new && phoneMode.mode != .phoneOnly {
                services.avHost.enableVolumeIntercept()
            } else {
                services.avHost.disableVolumeIntercept()
            }
        }
        .onChange(of: phoneMode.mode) { _, new in
            // Re-evaluate intercept when mode flips between phone-only
            // and the others (the playing flag may not change).
            if playback.playing && new != .phoneOnly {
                services.avHost.enableVolumeIntercept()
            } else {
                services.avHost.disableVolumeIntercept()
            }
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
        if terminal.keyboardOpen {
            return terminal.keyboardHeight + 16
        }
        // Always sit at the lifted (above tab bar) position so the
        // FABs don't shift between feed + terminal panes.
        let baseAboveNP: CGFloat = playback.playing ? 210 : 32
        return baseAboveNP + 56
    }

    // feedView + cycleFeedTab removed — feed lives in MainTabView.
}
