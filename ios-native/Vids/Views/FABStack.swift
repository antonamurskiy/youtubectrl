import SwiftUI

struct FABStack: View {
    @Environment(TerminalStore.self) private var terminal
    @Environment(ThemeStore.self) private var theme
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services
    @Environment(UIStore.self) private var ui

    var body: some View {
        VStack(spacing: 12) {
            Button(action: { terminal.toggle() }) {
                Image(systemName: "terminal")
                    .font(Font.app(14, weight: .bold))
                    .frame(width: 44, height: 44)
                    .background(.white.opacity(0.1))
                    .foregroundStyle(.white)
                    .clipShape(Circle())
            }
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
        Task { await feed.load(tab: feed.activeTab, api: services.api) }
    }
}
