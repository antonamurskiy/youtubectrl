import SwiftUI
import UIKit

/// Top-right segmented Picker for tmux windows, rendered as a sibling
/// of TerminalView in RootView so its .ignoresSafeArea(.keyboard) is
/// effective — the same modifier applied inside TerminalView's body
/// or via an .overlay() got carried up with the parent layout when
/// the soft keyboard opened.
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
            Picker("Window", selection: Binding(
                get: { activeIdx },
                set: { newIdx in
                    guard newIdx < terminal.windows.count, newIdx != activeIdx else { return }
                    let w = terminal.windows[newIdx]
                    optimisticallySelect(window: w)
                    Task { try? await services.api.tmuxSelect(index: w.index) }
                }
            )) {
                ForEach(Array(terminal.windows.enumerated()), id: \.offset) { idx, w in
                    Text(w.name).tag(idx)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: perTab * CGFloat(terminal.windows.count))
            .padding(.trailing, 8)
            .padding(.top, 4)
            .simultaneousGesture(
                LongPressGesture(minimumDuration: 0.5).onEnded { _ in
                    if activeIdx < terminal.windows.count {
                        renaming = terminal.windows[activeIdx]
                    }
                }
            )
            .onAppear { applyTint() }
            .onChange(of: theme.activeTmuxTint) { _, _ in applyTint() }
            .onChange(of: fonts.label) { _, _ in applyTint() }
            .onChange(of: fonts.size) { _, _ in applyTint() }
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

    private func applyTint() {
        let tint: UIColor = {
            if let c = theme.activeTmuxTint { return UIColor(c).withAlphaComponent(0.85) }
            return UIColor(white: 0.45, alpha: 0.7)
        }()
        let app = UISegmentedControl.appearance()
        app.selectedSegmentTintColor = tint
        let f = fonts.font(size: 13)
        app.setTitleTextAttributes([.font: f], for: .normal)
        app.setTitleTextAttributes([.font: f], for: .selected)
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.windows.first }
            .forEach { recolor($0, tint: tint, font: f) }
    }

    private func recolor(_ v: UIView, tint: UIColor, font: UIFont) {
        if let seg = v as? UISegmentedControl {
            seg.selectedSegmentTintColor = tint
            seg.setTitleTextAttributes([.font: font], for: .normal)
            seg.setTitleTextAttributes([.font: font], for: .selected)
        }
        for sub in v.subviews { recolor(sub, tint: tint, font: font) }
    }
}
