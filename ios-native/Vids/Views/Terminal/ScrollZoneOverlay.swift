import SwiftUI
import UIKit

/// Right-edge UIView that intercepts vertical pans and writes SGR
/// mouse-wheel sequences ("\x1b[<64;X;YM" up / "\x1b[<65;X;YM" down)
/// to the /ws/terminal socket so tmux's copy-mode buffer scrolls.
/// On touch end, fires /api/tmux-cancel-copy-mode so the user isn't
/// stuck in copy-mode after every scroll gesture.
struct ScrollZoneOverlay: UIViewRepresentable {
    @Environment(ServiceContainer.self) private var services

    func makeUIView(context: Context) -> ScrollZoneUIView {
        let v = ScrollZoneUIView()
        v.api = services.api
        return v
    }
    func updateUIView(_ uiView: ScrollZoneUIView, context: Context) {
        uiView.api = services.api
    }
}

final class ScrollZoneUIView: UIView {
    weak var api: ApiClient?
    private var lastY: CGFloat = 0
    private var ws: URLSessionWebSocketTask?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
        addGestureRecognizer(pan)
    }
    required init?(coder: NSCoder) { fatalError() }

    private func openWS() {
        if ws != nil { return }
        var c = URLComponents()
        c.scheme = "ws"
        let host = "yuzu.local:3000"
        let parts = host.split(separator: ":", maxSplits: 1).map(String.init)
        c.host = parts.first
        if parts.count > 1, let port = Int(parts[1]) { c.port = port }
        c.path = "/ws/terminal"
        guard let url = c.url else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        task.resume()
        ws = task
    }

    @objc private func onPan(_ g: UIPanGestureRecognizer) {
        let p = g.location(in: self)
        switch g.state {
        case .began:
            lastY = p.y
        case .changed:
            let dy = p.y - lastY
            // Per ~24pt of vertical movement = one wheel notch.
            let notches = Int(abs(dy) / 24)
            if notches >= 1 {
                lastY = p.y
                let up = dy > 0  // swiping down → tmux scrolls up (revealing earlier history)
                for _ in 0..<min(notches, 8) {
                    sendWheel(up: up)
                }
            }
        case .ended, .cancelled:
            Task { try? await api?.tmuxCancelCopyMode() }
        default: break
        }
    }

    private func sendWheel(up: Bool) {
        // Need to maintain our own WS for raw protocol bytes since
        // SwiftTerm's WS is owned by TermHost. Simpler: hit /api/tmux-send
        // with the SGR sequence — server forwards verbatim.
        // SGR mouse-wheel: 0x1B [ < 64 ; X ; Y M (up) or 65 (down).
        let cs = "\u{1B}[<\(up ? 64 : 65);1;1M"
        Task { try? await api?.tmuxSend(cs) }
    }
}
