import SwiftUI
import UIKit

/// Top-right segmented Picker for tmux windows. Wraps a per-instance
/// UISegmentedControl via UIViewRepresentable so tint + font config
/// is scoped to JUST this strip (UISegmentedControl.appearance() is
/// global and was leaking to the bottom feed Picker on the homepage).
struct TmuxTabStrip: View {
    @Environment(TerminalStore.self) private var terminal
    @Environment(ServiceContainer.self) private var services
    @Environment(ThemeStore.self) private var theme
    @Environment(FontStore.self) private var fonts
    @Binding var renaming: TmuxWindow?

    private let perTab: CGFloat = 64

    var body: some View {
        if terminal.windows.count > 1 {
            let activeIdx = terminal.windows.firstIndex(where: { $0.active }) ?? 0
            TmuxSegmentedRep(
                titles: terminal.windows.map { $0.name },
                selectedIndex: activeIdx,
                // Always a light translucent white overlay — Apple's
                // standard segmented control look. Per-window tmux
                // tint paints the surrounding panel chrome already;
                // tinting the active capsule on top of that produced
                // a same-color-on-same-color blob that didn't read
                // as "selected."
                tint: UIColor.white.withAlphaComponent(0.22),
                font: fonts.font(size: 13),
                onSelect: { newIdx in
                    guard newIdx < terminal.windows.count, newIdx != activeIdx else { return }
                    let w = terminal.windows[newIdx]
                    optimisticallySelect(window: w)
                    Task { try? await services.api.tmuxSelect(index: w.index) }
                },
                onLongPress: {
                    if activeIdx < terminal.windows.count {
                        renaming = terminal.windows[activeIdx]
                    }
                }
            )
            .frame(width: perTab * CGFloat(terminal.windows.count), height: 32)
        }
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

/// UISegmentedControl bridge — config applied per instance, no global
/// appearance leakage. Native iOS 26 Liquid Glass + magnify lens.
private struct TmuxSegmentedRep: UIViewRepresentable {
    let titles: [String]
    let selectedIndex: Int
    let tint: UIColor
    let font: UIFont
    let onSelect: (Int) -> Void
    let onLongPress: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSelect: onSelect, onLongPress: onLongPress)
    }

    func makeUIView(context: Context) -> UISegmentedControl {
        let sc = UISegmentedControl(items: titles)
        sc.selectedSegmentIndex = selectedIndex
        sc.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)),
                     for: .valueChanged)
        let lp = UILongPressGestureRecognizer(target: context.coordinator,
                                              action: #selector(Coordinator.longPressed(_:)))
        lp.minimumPressDuration = 0.5
        sc.addGestureRecognizer(lp)
        sc.selectedSegmentTintColor = tint
        applyTextAttributes(sc)
        return sc
    }

    private func applyTextAttributes(_ sc: UISegmentedControl) {
        // Active segment: pure white. Inactive: dim cream so the
        // active one stands out by contrast. Same font as the rest
        // of the app — DON'T swap to system bold (loses Berkeley Mono /
        // user-selected family).
        let activeAttrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor.white,
        ]
        let inactiveAttrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor(red: 0xeb/255, green: 0xdb/255, blue: 0xb2/255, alpha: 0.55),
        ]
        sc.setTitleTextAttributes(inactiveAttrs, for: .normal)
        sc.setTitleTextAttributes(activeAttrs, for: .selected)
    }

    func updateUIView(_ sc: UISegmentedControl, context: Context) {
        // Re-sync titles if the window list changed.
        if sc.numberOfSegments != titles.count {
            sc.removeAllSegments()
            for (i, t) in titles.enumerated() {
                sc.insertSegment(withTitle: t, at: i, animated: false)
            }
            applyTextAttributes(sc)
        } else {
            for (i, t) in titles.enumerated() {
                if sc.titleForSegment(at: i) != t {
                    sc.setTitle(t, forSegmentAt: i)
                }
            }
        }
        if sc.selectedSegmentIndex != selectedIndex {
            sc.selectedSegmentIndex = selectedIndex
        }
        if sc.selectedSegmentTintColor != tint {
            sc.selectedSegmentTintColor = tint
        }
        context.coordinator.onSelect = onSelect
        context.coordinator.onLongPress = onLongPress
    }

    final class Coordinator: NSObject {
        var onSelect: (Int) -> Void
        var onLongPress: () -> Void
        init(onSelect: @escaping (Int) -> Void, onLongPress: @escaping () -> Void) {
            self.onSelect = onSelect
            self.onLongPress = onLongPress
        }
        @objc func changed(_ sender: UISegmentedControl) {
            onSelect(sender.selectedSegmentIndex)
        }
        @objc func longPressed(_ g: UILongPressGestureRecognizer) {
            if g.state == .began { onLongPress() }
        }
    }
}
