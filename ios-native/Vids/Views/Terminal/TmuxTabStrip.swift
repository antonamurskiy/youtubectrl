import SwiftUI
import UIKit

/// Top-right tmux tab strip — per-pill Liquid Glass capsules, each
/// tinted with that window's color (terminal.colors[name]). Inactive
/// pills are dimmed; active pill uses a brighter version of its
/// color. GlassEffectContainer groups them so they morph as a unit.
///
/// Mounted via TmuxStripWindowHost as a direct UIWindow subview so
/// the keyboard doesn't shift it.
struct TmuxTabStrip: View {
    @Environment(TerminalStore.self) private var terminal
    @Environment(ServiceContainer.self) private var services
    @Environment(ThemeStore.self) private var theme
    @Environment(FontStore.self) private var fonts
    @Binding var renaming: TmuxWindow?

    var body: some View {
        if terminal.windows.count > 1 {
            GlassEffectContainer(spacing: 4) {
                HStack(spacing: 4) {
                    ForEach(terminal.windows) { w in
                        pill(for: w)
                    }
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 3)
            .background(
                Capsule()
                    .fill(Color.black.opacity(0.35))
                    .glassEffect(.regular.tint(.black.opacity(0.4)), in: Capsule())
            )
            .clipShape(Capsule())
        }
    }

    @ViewBuilder
    private func pill(for w: TmuxWindow) -> some View {
        let active = w.active
        let baseColor: Color = {
            if let hex = terminal.resolveColor(w.name) {
                return Color(hex: hex)
            }
            return Color.white.opacity(0.18)
        }()
        // Active = full saturation tint; inactive = darker, lower
        // opacity so it reads as a subdued chip.
        let pillTint: Color = active
            ? baseColor.opacity(0.85)
            : baseColor.darken(0.55).opacity(0.55)
        let textColor: Color = active
            ? Color.white
            : Color.appText.opacity(0.6)

        Button(action: {
            optimisticallySelect(window: w)
            Task { try? await services.api.tmuxSelect(index: w.index) }
        }) {
            Text(w.name)
                .font(Font.app(13, weight: active ? .heavy : .semibold))
                .foregroundStyle(textColor)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.tint(pillTint).interactive(), in: Capsule())
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.5).onEnded { _ in renaming = w }
        )
    }

    private func optimisticallySelect(window w: TmuxWindow) {
        terminal.windows = terminal.windows.map { existing in
            TmuxWindow(index: existing.index,
                       name: existing.name,
                       active: existing.index == w.index,
                       title: existing.title)
        }
    }
}
