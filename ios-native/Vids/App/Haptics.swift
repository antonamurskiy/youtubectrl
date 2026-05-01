import UIKit

/// Single hop for haptic feedback so we can swap engines later.
/// React app calls these "hapticThump" — same idea.
enum Haptics {
    /// Light bump for routine taps (FAB, transport, list select).
    static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
    /// Medium for state-toggling taps (visibility, monitor switch).
    static func toggle() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }
    /// Soft selection click for picker / segmented changes.
    static func select() {
        UISelectionFeedbackGenerator().selectionChanged()
    }
    /// Sharp success/failure burst for confirmable actions.
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}
