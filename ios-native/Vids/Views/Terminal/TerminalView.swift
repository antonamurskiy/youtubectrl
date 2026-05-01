import SwiftUI
import UIKit

/// Phase 1 placeholder: tmux tab strip + plain UITextView feed dump.
/// Phase 7 swaps in SwiftTerm for actual PTY rendering. For now we just
/// show that the WS-driven tmux state surfaces correctly.
struct TerminalView: View {
    @Environment(TerminalStore.self) private var terminal
    @Environment(ServiceContainer.self) private var services
    @Environment(ThemeStore.self) private var theme

    var body: some View {
        VStack(spacing: 0) {
            // Tmux tab strip.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(terminal.windows) { w in
                        Button(action: { Task { try? await services.api.tmuxSelect(index: w.index) } }) {
                            Text(w.name)
                                .font(.system(size: 13, weight: .semibold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(tabBg(w))
                                .foregroundStyle(.white)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            .background(theme.resolvedSurface)

            // Placeholder body.
            ZStack {
                Color.black.opacity(0.4)
                Text("Terminal — phase 7 (SwiftTerm) — \(terminal.activeWindow?.name ?? "no active window")")
                    .font(.system(size: 14, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.7))
                    .multilineTextAlignment(.center)
                    .padding()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(theme.resolvedSurface)
        .ignoresSafeArea(edges: .bottom)
    }

    private func tabBg(_ w: TmuxWindow) -> Color {
        guard let hex = terminal.resolveColor(w.name) else {
            return w.active ? Color.white.opacity(0.15) : Color.white.opacity(0.05)
        }
        return Color(hex: hex).darken(0.55).opacity(w.active ? 1 : 0.7)
    }
}
