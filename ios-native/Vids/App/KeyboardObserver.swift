import UIKit

/// Watches keyboardWillShow/Hide and updates TerminalStore.keyboardOpen.
/// NowPlayingBar's mount predicate (terminal.open && terminal.keyboardOpen)
/// hides the bar while typing in the terminal panel.
final class KeyboardObserver {
    weak var terminal: TerminalStore?
    private var observers: [Any] = []

    func start(terminal: TerminalStore) {
        self.terminal = terminal
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in
            self?.terminal?.keyboardOpen = true
        })
        observers.append(nc.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
            self?.terminal?.keyboardOpen = false
        })
    }

    deinit {
        for o in observers { NotificationCenter.default.removeObserver(o) }
    }
}
