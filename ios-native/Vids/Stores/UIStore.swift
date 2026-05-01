import Foundation
import Observation

@Observable
final class UIStore {
    var toasts: [Toast] = []
    var volumePulse: VolumePulse? = nil
    var secretMenuOpen: Bool = false

    @MainActor
    func toast(_ text: String, duration: TimeInterval = 1.6) {
        let t = Toast(text: text)
        toasts.append(t)
        // Use a runloop Timer rather than Task.sleep — observed Task
        // continuations being delayed indefinitely under SwiftUI render
        // pressure, leaving toasts pinned on screen.
        Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { [weak self] _ in
            self?.toasts.removeAll { $0.id == t.id }
        }
    }

    @MainActor
    func showVolume(_ percent: Int) {
        let v = VolumePulse(percent: percent)
        volumePulse = v
        Task {
            try? await Task.sleep(nanoseconds: 900_000_000)
            await MainActor.run { if self.volumePulse?.id == v.id { self.volumePulse = nil } }
        }
    }
}

struct Toast: Identifiable, Hashable {
    let id = UUID()
    let text: String
}

struct VolumePulse: Identifiable, Hashable {
    let id = UUID()
    let percent: Int
}
