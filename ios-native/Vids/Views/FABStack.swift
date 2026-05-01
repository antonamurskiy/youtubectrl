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

    var body: some View {
        VStack(spacing: 12) {
            Button(action: { terminal.toggle() }) {
                Image(systemName: "terminal")
                    .font(Font.app(14, weight: .bold))
                    .frame(width: 44, height: 44)
                    .background((claudeColor ?? Color.white).opacity(claudeColor != nil ? 0.18 : 0.1))
                    .foregroundStyle(claudeColor ?? Color.white)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(claudeColor ?? Color.clear, lineWidth: 1.5))
                    .scaleEffect(claudePulse ? 1.08 : 1)
                    .animation(claudeColor != nil
                                ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true)
                                : .default,
                               value: claudePulse)
            }
            .onChange(of: playback.claudeState) { _, _ in
                claudePulse = (claudeColor != nil)
            }
            .task { claudePulse = (claudeColor != nil) }
            Button(action: refresh) {
                Image(systemName: "arrow.clockwise")
                    .font(Font.app(14, weight: .bold))
                    .frame(width: 44, height: 44)
                    .background(.white.opacity(0.1))
                    .foregroundStyle(.white)
                    .clipShape(Circle())
            }
            .simultaneousGesture(
                LongPressGesture(minimumDuration: 0.5)
                    .onEnded { _ in ui.secretMenuOpen = true }
            )
        }
    }

    private func refresh() {
        feed.refreshTick &+= 1
        Task { await feed.load(tab: feed.activeTab, api: services.api) }
    }
}
