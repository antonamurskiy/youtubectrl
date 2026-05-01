import SwiftUI
import UIKit
import Observation

@Observable
final class ThemeStore {
    /// Tints that paint full-screen surfaces (body / gutter / panel /
    /// fab / np-bar / header) when the corresponding tab is active.
    static let tabTints: [FeedTab: Color] = [
        .history: Color(hex: "#1f3d24"),
        .live: Color(hex: "#a13a36"),
        .ru: Color(hex: "#4f8a5c"),
    ]

    var activeTabTint: Color? = nil
    var activeTmuxTint: Color? = nil
    var terminalOpen: Bool = false

    /// The actual surface tint, picking terminal tmux tint over the
    /// per-tab tint when terminal is open.
    var resolved: Color? { terminalOpen ? activeTmuxTint : activeTabTint }

    /// Darkened version used as background. Matches the JS darkenHex(0.55).
    var resolvedSurface: Color { resolved?.darken(0.55) ?? Color(hex: "#282828") }
    var resolvedFill: Color { resolved ?? Color(hex: "#a89984") }
    var resolvedTrack: Color { resolved?.darken(0.4) ?? Color(hex: "#3c3836") }

    func setTabTint(for tab: FeedTab) {
        activeTabTint = Self.tabTints[tab]
    }
}

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        var rgb: UInt64 = 0
        Scanner(string: s).scanHexInt64(&rgb)
        let r = Double((rgb >> 16) & 0xFF) / 255
        let g = Double((rgb >> 8) & 0xFF) / 255
        let b = Double(rgb & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }

    func darken(_ factor: Double) -> Color {
        let ui = UIColor(self)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        ui.getRed(&r, green: &g, blue: &b, alpha: &a)
        return Color(red: Double(r) * factor, green: Double(g) * factor, blue: Double(b) * factor, opacity: Double(a))
    }
}
