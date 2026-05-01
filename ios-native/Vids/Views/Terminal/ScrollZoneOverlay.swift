import SwiftUI
import UIKit

/// Right-edge overlay that captures vertical pans and forwards SGR
/// mouse-wheel sequences to tmux via its own /ws/terminal connection.
/// /api/tmux-send won't work because the server wraps the payload in
/// `tmux send-keys "..." Enter` — that types the escape chars as
/// literal keystrokes, not a mouse event. PTY-direct via WS goes
/// through tmux's mouse-mode parser.
struct ScrollZoneOverlay: UIViewRepresentable {
    @Environment(ServiceContainer.self) private var services

    func makeUIView(context: Context) -> ScrollZoneUIView {
        let v = ScrollZoneUIView()
        v.api = services.api
        v.host = services.serverHost
        v.openWS()
        return v
    }
    func updateUIView(_ uiView: ScrollZoneUIView, context: Context) {
        uiView.api = services.api
        uiView.host = services.serverHost
    }
}

final class ScrollZoneUIView: UIView {
    weak var api: ApiClient?
    var host: String = "yuzu.local:3000"
    private var lastY: CGFloat = 0
    private var ws: URLSessionWebSocketTask?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
        addGestureRecognizer(pan)
    }
    required init?(coder: NSCoder) { fatalError() }

    func openWS() {
        if ws != nil { return }
        var c = URLComponents()
        c.scheme = "ws"
        let parts = host.split(separator: ":", maxSplits: 1).map(String.init)
        c.host = parts.first
        if parts.count > 1, let port = Int(parts[1]) { c.port = port }
        c.path = "/ws/terminal"
        guard let url = c.url else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        task.resume()
        ws = task
        // Drain incoming so the socket stays alive (we ignore the data).
        recv()
    }

    private func recv() {
        ws?.receive { [weak self] _ in self?.recv() }
    }

    @objc private func onPan(_ g: UIPanGestureRecognizer) {
        let p = g.location(in: self)
        switch g.state {
        case .began:
            lastY = p.y
        case .changed:
            let dy = p.y - lastY
            let notches = Int(abs(dy) / 24)
            if notches >= 1 {
                lastY = p.y
                let up = dy > 0  // swipe down → reveal earlier history
                for _ in 0..<min(notches, 8) { sendWheel(up: up) }
            }
        case .ended, .cancelled:
            Task { try? await api?.tmuxCancelCopyMode() }
        default: break
        }
    }

    private func sendWheel(up: Bool) {
        // SGR mouse-wheel: ESC [ < (64=up | 65=down) ; col ; row M.
        // Send directly to /ws/terminal — tmux's mouse-mode parser
        // reads PTY input and scrolls.
        let cs = "\u{1B}[<\(up ? 64 : 65);1;1M"
        ws?.send(.string(cs)) { _ in }
    }
}
