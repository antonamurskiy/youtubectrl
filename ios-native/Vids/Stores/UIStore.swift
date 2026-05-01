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
        Task {
            try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
            await MainActor.run { self.toasts.removeAll { $0.id == t.id } }
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
