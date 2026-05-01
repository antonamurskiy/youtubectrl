import SwiftUI

struct FABStack: View {
    @Environment(TerminalStore.self) private var terminal
    @Environment(ThemeStore.self) private var theme
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services
    @Environment(UIStore.self) private var ui
    @Environment(PlaybackStore.self) private var playback
    @State private var claudePulse: Bool = false

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
        GlassEffectContainer(spacing: 12) {
            VStack(spacing: 12) {
                Button(action: { terminal.toggle() }) {
                    Image(systemName: "terminal")
                        .font(.system(size: 16, weight: .bold))
                        .frame(width: 48, height: 48)
                        .foregroundStyle(claudeColor ?? fabFg)
                        .scaleEffect(claudePulse ? 1.08 : 1)
                        .animation(claudeColor != nil
                                    ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true)
                                    : .default,
                                   value: claudePulse)
                }
                .glassEffect(
                    .regular.tint(claudeColor.map { $0.opacity(0.45) } ?? fabBg).interactive(),
                    in: Circle()
                )
                .onChange(of: playback.claudeState) { _, _ in
                    claudePulse = (claudeColor != nil)
                }
                .task { claudePulse = (claudeColor != nil) }

                Button(action: refresh) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 16, weight: .bold))
                        .frame(width: 48, height: 48)
                        .foregroundStyle(feed.isCurrentTabLoading ? Color(hex: "#8ec07c") : fabFg)
                        .rotationEffect(.degrees(feed.isCurrentTabLoading ? 360 : 0))
                        .animation(
                            feed.isCurrentTabLoading
                                ? .linear(duration: 0.9).repeatForever(autoreverses: false)
                                : .default,
                            value: feed.isCurrentTabLoading
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
                        .onEnded { _ in ui.secretMenuOpen = true }
                )
            }
        }
    }

    private func refresh() {
        feed.refreshTick &+= 1
        Task { await feed.load(tab: feed.activeTab, api: services.api) }
    }
}
