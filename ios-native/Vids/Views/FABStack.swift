import SwiftUI

struct FABStack: View {
    @Environment(TerminalStore.self) private var terminal
    @Environment(ThemeStore.self) private var theme
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services
    @Environment(UIStore.self) private var ui
    @Environment(PlaybackStore.self) private var playback
    private var claudeColor: Color? {
        switch playback.claudeState {
        case "waiting": return Color(hex: "#b16286")  // magenta
        case "thinking": return Color(hex: "#e5b567") // yellow
        default: return nil
        }
    }

    /// Default FAB chrome — translucent dark grey + cream text.
    /// Matches React's .fab-* (rgba(40,40,40,0.7) bg, --text-dim).
    private static let fabBgDefault = Color(red: 40/255, green: 40/255, blue: 40/255).opacity(0.7)
    private static let fabFgDefault = Color(hex: "#a89984")

    /// Track the tmux pane tint when terminal is open so FABs blend
    /// with the surrounding panel chrome instead of looking out of
    /// place against the colored bg.
    private var fabBg: Color {
        if terminal.open, let tint = theme.activeTmuxTint {
            return tint.opacity(0.5)
        }
        return FABStack.fabBgDefault
    }
    private var fabFg: Color { FABStack.fabFgDefault }

    var body: some View {
        // GlassEffectContainer lets the two FABs share a single Liquid
        // Glass field — they refract together, like Apple's Camera /
        // Photos floating controls on iOS 26.
        GlassEffectContainer(spacing: 8) {
            VStack(spacing: 8) {
                // Keyboard dismiss FAB — only when soft keyboard is up
                // and terminal is open. Lives in the same stack as
                // the others so it inherits the 12pt VStack spacing
                // automatically.
                if terminal.open && terminal.keyboardOpen {
                    Button(action: {
                        Haptics.tap()
                        terminal.dismissKeyboard?()
                    }) {
                        Image(systemName: "keyboard.chevron.compact.down")
                            .font(.system(size: 16, weight: .bold))
                            .frame(width: 48, height: 48)
                            .foregroundStyle(fabFg)
                    }
                    .glassEffect(.regular.tint(fabBg).interactive(), in: Circle())
                    .transition(.scale.combined(with: .opacity))
                }
                Button(action: { Haptics.tap(); terminal.toggle() }) {
                    Image(systemName: "terminal")
                        .font(.system(size: 16, weight: .bold))
                        .frame(width: 48, height: 48)
                        .foregroundStyle(claudeColor ?? fabFg)
                        // Liquid Glass scale phase animator for the
                        // claude waiting/thinking pulse — replaces the
                        // fragile repeatForever scaleEffect.
                        .symbolEffect(
                            .pulse.byLayer,
                            options: .repeating,
                            isActive: claudeColor != nil
                        )
                }
                .glassEffect(
                    .regular.tint(claudeColor.map { $0.opacity(0.45) } ?? fabBg).interactive(),
                    in: Circle()
                )

                Button(action: refresh) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 16, weight: .bold))
                        .frame(width: 48, height: 48)
                        .foregroundStyle(feed.isCurrentTabLoading ? Color(hex: "#8ec07c") : fabFg)
                        // Native iOS 18+ rotation symbol-effect — much
                        // smoother than the manual rotationEffect +
                        // repeatForever animation it replaces.
                        .symbolEffect(
                            .rotate.byLayer,
                            options: .repeating.speed(0.9),
                            isActive: feed.isCurrentTabLoading
                        )
                }
                .glassEffect(
                    .regular.tint(feed.isCurrentTabLoading
                                  ? Color(hex: "#8ec07c").opacity(0.35)
                                  : fabBg).interactive(),
                    in: Circle()
                )
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0.5)
                        .onEnded { _ in
                            Haptics.success()
                            ui.secretMenuOpen = true
                        }
                )
            }
        }
    }

    private func refresh() {
        Haptics.tap()
        feed.refreshTick &+= 1
        Task { await feed.load(tab: feed.activeTab, api: services.api) }
    }
}
