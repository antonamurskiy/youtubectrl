import UIKit

/// Watches keyboardWillShow/Hide and updates TerminalStore.keyboardOpen.
/// NowPlayingBar's mount predicate (terminal.open && terminal.keyboardOpen)
/// hides the bar while typing in the terminal panel.
final class KeyboardObserver {
    weak var terminal: TerminalStore?
    private var observers: [Any] = []

    var onKeyboardDidShow: (() -> Void)?

    func start(terminal: TerminalStore) {
        self.terminal = terminal
        let nc = NotificationCenter.default
        // NotificationCenter delivers on .main GCD queue, but @Observable
        // tracking expects updates from the MainActor — dispatch
        // explicitly so SwiftUI picks them up.
        observers.append(nc.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] note in
            let h = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect)?.height ?? 336
            Task { @MainActor in
                self?.terminal?.keyboardOpen = true
                self?.terminal?.keyboardHeight = h
            }
            // Theme on willShow + didShow + 100ms after — SwiftTerm
            // builds the accessory at any of these moments.
            for delay in [0.0, 0.05, 0.15] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    self?.onKeyboardDidShow?()
                }
            }
        })
        observers.append(nc.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] note in
            let h = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect)?.height ?? 336
            Task { @MainActor in self?.terminal?.keyboardHeight = h }
        })
        observers.append(nc.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.terminal?.keyboardOpen = false
                self?.terminal?.keyboardHeight = 0
            }
        })
        observers.append(nc.addObserver(forName: UIResponder.keyboardDidShowNotification, object: nil, queue: .main) { [weak self] _ in
            // Keyboard accessory view buttons are rebuilt each show —
            // re-theme so SwiftTerm's grey doesn't bleed through.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                self?.onKeyboardDidShow?()
            }
        })
    }

    deinit {
        for o in observers { NotificationCenter.default.removeObserver(o) }
    }
}
