import Foundation
import Observation

@Observable
final class TerminalStore {
    var open: Bool = false
    var windows: [TmuxWindow] = []
    var colors: [String: String] = [:]
    var colorPreview: [String: String] = [:]
    var feed: [String] = []
    var keyboardOpen: Bool = false
    /// Actual on-screen keyboard height (incl. predictive bar). Set by KeyboardObserver.
    var keyboardHeight: CGFloat = 0
    /// Was the keyboard up the moment terminal last closed? When true, the
    /// next open auto-focuses the SwiftTerm view to bring the keyboard back.
    /// Matches the React app's `wasKbOpenAtCloseRef` behavior so users don't
    /// have to re-tap to type after every toggle.
    var wasKeyboardOpenAtClose: Bool = false

    var activeWindow: TmuxWindow? { windows.first(where: { $0.active }) }

    func resolveColor(_ name: String) -> String? {
        if let c = colorPreview[name], !c.isEmpty { return c }
        return colors[name]
    }

    func apply(windows: [TmuxWindow]?, colors: [String: String]?) {
        if let w = windows, w != self.windows { self.windows = w }
        if let c = colors, c != self.colors { self.colors = c }
    }

    func toggle() { open.toggle() }
}
