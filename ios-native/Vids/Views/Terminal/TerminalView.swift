import SwiftUI
import UIKit
import SwiftTerm

struct TerminalView: View {
    @Environment(TerminalStore.self) private var terminal
    @Environment(ServiceContainer.self) private var services
    @Environment(ThemeStore.self) private var theme
    @State private var renaming: TmuxWindow? = nil

    var body: some View {
        VStack(spacing: 0) {
            // Tmux tab strip — only shows when server reports >1 window.
            if terminal.windows.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(terminal.windows) { w in
                            Button(action: { Task { try? await services.api.tmuxSelect(index: w.index) } }) {
                                Text(w.name)
                                    .font(.system(size: 13, weight: .semibold))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(tabBg(w))
                                    .foregroundStyle(.white)
                            }
                            .buttonStyle(.plain)
                            .simultaneousGesture(
                                LongPressGesture(minimumDuration: 0.5)
                                    .onEnded { _ in renaming = w }
                            )
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                .background(theme.resolvedSurface)
            }

            ZStack(alignment: .trailing) {
                TermHost(host: services.serverHost, onSwipe: switchTmuxWindow(by:))
                    .background(theme.resolvedSurface)
                ScrollZoneOverlay()
                    .frame(width: 56)
            }
        }
        .background(theme.resolvedSurface)
        .ignoresSafeArea(.container, edges: .bottom)
        .overlay {
            if let w = renaming {
                ZStack {
                    Color.black.opacity(0.4).ignoresSafeArea()
                        .onTapGesture { renaming = nil }
                    TmuxRenamePopover(window: w, open: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }))
                }
            }
        }
    }

    private func switchTmuxWindow(by delta: Int) {
        let windows = terminal.windows
        guard windows.count > 1,
              let activeIdx = windows.firstIndex(where: { $0.active }) else { return }
        let next = (activeIdx + delta + windows.count) % windows.count
        let target = windows[next]
        Task { try? await services.api.tmuxSelect(index: target.index) }
    }

    private func tabBg(_ w: TmuxWindow) -> SwiftUI.Color {
        guard let hex = terminal.resolveColor(w.name) else {
            return w.active ? SwiftUI.Color.white.opacity(0.15) : SwiftUI.Color.white.opacity(0.05)
        }
        return SwiftUI.Color(hex: hex).darken(0.55).opacity(w.active ? 1 : 0.7)
    }
}

/// SwiftTerm host wired to the server's `/ws/terminal` PTY endpoint.
/// Receives raw bytes (ANSI escape codes), feeds them to SwiftTerm's
/// emulator. Sends user keypresses back as bytes.
struct TermHost: UIViewRepresentable {
    let host: String
    let onSwipe: (Int) -> Void  // called with -1 (prev) or +1 (next)

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        let tv = SwiftTerm.TerminalView(frame: .zero)
        tv.terminalDelegate = context.coordinator
        tv.backgroundColor = UIColor(red: 0x28/255.0, green: 0x28/255.0, blue: 0x28/255.0, alpha: 1)
        tv.nativeForegroundColor = UIColor(red: 0xeb/255.0, green: 0xdb/255.0, blue: 0xb2/255.0, alpha: 1)
        tv.nativeBackgroundColor = UIColor(red: 0x28/255.0, green: 0x28/255.0, blue: 0x28/255.0, alpha: 1)
        if let font = UIFont(name: "Menlo-Regular", size: 13) {
            tv.font = font
        }
        context.coordinator.onSwipe = onSwipe
        context.coordinator.attach(tv: tv, host: host)
        let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.onSwipePan(_:)))
        pan.delegate = context.coordinator
        pan.cancelsTouchesInView = false
        pan.delaysTouchesBegan = false
        pan.delaysTouchesEnded = false
        tv.addGestureRecognizer(pan)
        return tv
    }

    func updateUIView(_ uiView: SwiftTerm.TerminalView, context: Context) {
        context.coordinator.ensureConnected(host: host)
    }

    static func dismantleUIView(_ uiView: SwiftTerm.TerminalView, coordinator: Coordinator) {
        coordinator.disconnect()
    }

    final class Coordinator: NSObject, TerminalViewDelegate, UIGestureRecognizerDelegate {
        private var ws: URLSessionWebSocketTask?
        private weak var tv: SwiftTerm.TerminalView?
        private var connectedHost: String?
        private let session = URLSession(configuration: .default)
        var onSwipe: ((Int) -> Void)?
        private var swipeStart: CGPoint?

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }

        @objc func onSwipePan(_ g: UIPanGestureRecognizer) {
            guard let view = g.view else { return }
            switch g.state {
            case .began:
                swipeStart = g.location(in: view)
            case .ended:
                guard let start = swipeStart else { return }
                let end = g.location(in: view)
                let dx = end.x - start.x, dy = end.y - start.y
                swipeStart = nil
                // Require: |dx| > 60, dominant horizontal motion.
                guard abs(dx) > 60, abs(dx) > abs(dy) * 1.5 else { return }
                onSwipe?(dx > 0 ? -1 : 1)  // swipe right = previous window
            case .cancelled, .failed:
                swipeStart = nil
            default: break
            }
        }

        func attach(tv: SwiftTerm.TerminalView, host: String) {
            self.tv = tv
            ensureConnected(host: host)
        }

        func ensureConnected(host: String) {
            if connectedHost == host, ws != nil { return }
            disconnect()
            connectedHost = host
            var c = URLComponents()
            c.scheme = "ws"
            let parts = host.split(separator: ":", maxSplits: 1).map(String.init)
            c.host = parts.first
            if parts.count > 1, let port = Int(parts[1]) { c.port = port }
            c.path = "/ws/terminal"
            guard let url = c.url else { return }
            let task = session.webSocketTask(with: url)
            ws = task
            task.resume()
            // Send initial resize so server's PTY matches our TerminalView geometry.
            sendResize()
            recvLoop()
        }

        func disconnect() {
            ws?.cancel()
            ws = nil
        }

        private func recvLoop() {
            ws?.receive { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let msg):
                    self.handle(msg)
                    self.recvLoop()
                case .failure:
                    self.ws = nil
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                        if let host = self.connectedHost {
                            self.connectedHost = nil
                            self.ensureConnected(host: host)
                        }
                    }
                }
            }
        }

        private func handle(_ msg: URLSessionWebSocketTask.Message) {
            let bytes: [UInt8]
            switch msg {
            case .data(let d): bytes = [UInt8](d)
            case .string(let s): bytes = [UInt8](s.utf8)
            @unknown default: return
            }
            DispatchQueue.main.async { [weak self] in
                self?.tv?.feed(byteArray: bytes[...])
            }
        }

        private func sendResize() {
            guard let tv, let ws else { return }
            let cols = tv.getTerminal().cols
            let rows = tv.getTerminal().rows
            // Server's /ws/terminal protocol: "\x01r<cols>,<rows>" for resize.
            let str = "\u{01}r\(cols),\(rows)"
            ws.send(.string(str)) { _ in }
        }

        // MARK: TerminalViewDelegate

        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
            guard let ws else { return }
            // Server expects strings; PTY-bound bytes are typically ASCII / UTF-8.
            if let s = String(bytes: data, encoding: .utf8) {
                ws.send(.string(s)) { _ in }
            } else {
                ws.send(.data(Data(data))) { _ in }
            }
        }

        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
            sendResize()
        }

        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
        func scrolled(source: SwiftTerm.TerminalView, position: Double) {}
        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {
            if let s = String(data: content, encoding: .utf8) {
                UIPasteboard.general.string = s
            }
        }
        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}
        func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String : String]) {
            if let url = URL(string: link) { UIApplication.shared.open(url) }
        }
        func bell(source: SwiftTerm.TerminalView) {}
        func iTermContent(source: SwiftTerm.TerminalView, content: ArraySlice<UInt8>) {}
    }
}
