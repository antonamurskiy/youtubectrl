import SwiftUI
import UIKit

/// Mounts the TmuxTabStrip as a direct subview of the app's UIWindow
/// via a UIHostingController, anchored to top-trailing safe area.
/// SwiftUI's safe-area + keyboard-avoidance pipeline is bypassed
/// entirely — the strip stays absolutely pinned regardless of soft
/// keyboard, presentation sheets, or any view-tree shifts.
struct TmuxStripWindowHost: UIViewRepresentable {
    let visible: Bool
    @Binding var renaming: TmuxWindow?
    @Environment(TerminalStore.self) private var terminal
    @Environment(ServiceContainer.self) private var services
    @Environment(ThemeStore.self) private var theme
    @Environment(FontStore.self) private var fonts

    func makeUIView(context: Context) -> UIView {
        // Invisible probe view — its only job is to find a UIWindow
        // we can attach the strip to. Returns a tiny 1pt frame so it
        // doesn't take up space.
        let probe = UIView(frame: .zero)
        probe.isUserInteractionEnabled = false
        probe.alpha = 0
        return probe
    }

    func updateUIView(_ probe: UIView, context: Context) {
        // Defer to next runloop so probe.window is non-nil.
        DispatchQueue.main.async {
            self.sync(probe: probe, context: context)
        }
    }

    private func sync(probe: UIView, context: Context) {
        guard let window = probe.window
                ?? UIApplication.shared.connectedScenes
                    .compactMap({ $0 as? UIWindowScene })
                    .flatMap({ $0.windows })
                    .first(where: { $0.isKeyWindow })
        else { return }

        if !visible {
            context.coordinator.detach()
            return
        }

        let strip = TmuxTabStrip(renaming: $renaming)
            .environment(terminal)
            .environment(services)
            .environment(theme)
            .environment(fonts)

        if let host = context.coordinator.host {
            host.rootView = AnyView(strip)
        } else {
            let host = UIHostingController(rootView: AnyView(strip))
            host.view.backgroundColor = .clear
            host.view.translatesAutoresizingMaskIntoConstraints = false
            window.addSubview(host.view)
            // Anchor to safe-area-top, trailing. Keyboard never
            // affects top safe area; window subviews don't get
            // SwiftUI's keyboard-avoidance shift.
            NSLayoutConstraint.activate([
                host.view.topAnchor.constraint(equalTo: window.safeAreaLayoutGuide.topAnchor, constant: 4),
                host.view.trailingAnchor.constraint(equalTo: window.safeAreaLayoutGuide.trailingAnchor, constant: -8),
            ])
            context.coordinator.host = host
            context.coordinator.window = window
        }
    }

    static func dismantleUIView(_ probe: UIView, coordinator: Coordinator) {
        coordinator.detach()
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var host: UIHostingController<AnyView>?
        weak var window: UIWindow?
        func detach() {
            host?.view.removeFromSuperview()
            host?.removeFromParent()
            host = nil
        }
    }
}
