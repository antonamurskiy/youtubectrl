import SwiftUI

struct FABStack: View {
    @Environment(TerminalStore.self) private var terminal
    @Environment(ThemeStore.self) private var theme
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services

    var body: some View {
        VStack(spacing: 12) {
            Button(action: { terminal.toggle() }) {
                Image(systemName: "terminal")
                    .font(.system(size: 14, weight: .bold))
                    .frame(width: 44, height: 44)
                    .background(.white.opacity(0.1))
                    .foregroundStyle(.white)
                    .clipShape(Circle())
            }
            Button(action: refresh) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 14, weight: .bold))
                    .frame(width: 44, height: 44)
                    .background(.white.opacity(0.1))
                    .foregroundStyle(.white)
                    .clipShape(Circle())
            }
        }
    }

    private func refresh() {
        Task { await feed.load(tab: feed.activeTab, api: services.api) }
    }
}
