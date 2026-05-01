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
            let bottomInset: CGFloat = (playback.playing && !terminal.keyboardOpen)
                ? 175
                : 0
            // Keep TerminalView ALWAYS mounted — opening / closing only
            // toggles opacity + hit testing. Conditional mounting tore
            // down the PTY + SwiftTerm view + WS connection on close,
            // producing a visible blink when reopening (cold xterm
            // re-init, scroll-to-bottom, font reload). Persistent mount
            // keeps the session warm.
            if hSize == .regular {
                HStack(spacing: 0) {
                    feedView
                        .frame(maxWidth: .infinity)
                    TerminalView(bottomInset: bottomInset)
                        .frame(maxWidth: .infinity)
                        .opacity(terminal.open ? 1 : 0)
                        .allowsHitTesting(terminal.open)
                }
            } else {
                feedView
                    .opacity(terminal.open ? 0 : 1)
                    .allowsHitTesting(!terminal.open)
                TerminalView(bottomInset: bottomInset)
                    .opacity(terminal.open ? 1 : 0)
                    .allowsHitTesting(terminal.open)
            }

            // Phone-sync / phone-only video frame, hosting AVPlayerHost.containerView.
            // Sized via GeometryReader from the parent so it adapts to
            // landscape + iPad regular size class.
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
                        Spacer(minLength: 0)
                    }
                    .padding(.top, 70)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .zIndex(5)
            }

            // Now-playing bar — hidden when terminal+keyboard. On
            // regular size class (iPad / landscape iPhone Pro Max),
            // cap its width so it doesn't span the whole screen.
            if playback.playing && !(terminal.open && terminal.keyboardOpen) {
                NowPlayingBar()
                    .frame(maxWidth: hSize == .regular ? 600 : .infinity)
                    .frame(maxWidth: .infinity)
                    // Measure BEFORE the .ignoresSafeArea modifiers —
                    // on iOS 26 a GeometryReader behind a view that
                    // ignores .container reports size 0×0.
                    .background(GeometryReader { geo in
                        Color.clear
                            .preference(key: NPBarHeightKey.self, value: geo.size.height)
                            .preference(key: NPBarFrameKey.self, value: geo.frame(in: .global))
                    })
                    .ignoresSafeArea(.container, edges: .bottom)
                    .ignoresSafeArea(.keyboard, edges: .bottom)
                    // Plain opacity fade — the move(.bottom) transition
                    // started from wherever the keyboard had pushed
                    // the safe area, then snapped to the real bottom
                    // once the keyboard finished dismissing.
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

            ToastHUD().zIndex(30)
            VolumeHUD().zIndex(31)
            ClaudeFeedView().zIndex(25)
            ClaudeQuickReply().zIndex(28)
            // Sibling overlay so the floating tile lives ABOVE the
            // NPBar's glass clip — same layer pattern AVKit uses for
            // its scrub preview thumbnail.
            ScrubPreviewOverlay(barHeight: npBarHeight)
                .zIndex(15)
                .ignoresSafeArea()

        }
        .sheet(isPresented: Binding(
            get: { ui.secretMenuOpen },
            set: { ui.secretMenuOpen = $0 }
        )) {
            SecretMenu()
                // Two detents: medium for quick glance, large for the
                // full menu. .large was previously dropped because the
                // sheet's clear-row List rendered invisibly at full
                // detent — the new glass-card layout has its own
                // backgrounds so .large works again.
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

    private func cycleFeedTab(by delta: Int) {
        let all = FeedTab.allCases
        guard let i = all.firstIndex(of: feed.activeTab) else { return }
        let next = all[(i + delta + all.count) % all.count]
        feed.activeTab = next
        Task { await feed.load(tab: next, api: services.api) }
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
                .foregroundStyle(Color.appText)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Color.appText.opacity(0.06))
            }
            ZStack(alignment: .top) {
                FeedListView(onSwipe: cycleFeedTab(by:))
                    .ignoresSafeArea(.container, edges: .bottom)
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
        // Swipe is now wired via UIKit gesture on the FeedListView's
        // UICollectionView (FeedListView.onSwipe) — SwiftUI's DragGesture
        // didn't coexist well with the inner scroll view's pans.
    }
}
