import SwiftUI
import UIKit
import SwiftTerm

struct TerminalView: View {
    let bottomInset: CGFloat
    @Environment(TerminalStore.self) private var terminal
    @Environment(ServiceContainer.self) private var services
    @Environment(ThemeStore.self) private var theme
    @Environment(FontStore.self) private var fonts
    @State private var renaming: TmuxWindow? = nil
    @State private var termCoordinator: TermHost.Coordinator? = nil
    init(bottomInset: CGFloat = 0) { self.bottomInset = bottomInset }

    var body: some View {
        VStack(spacing: 0) {
            // Tmux tab strip — only shows when server reports >1 window.
            if terminal.windows.count > 1 {
                // Right-align via a GeometryReader-backed min-width
                // frame inside a horizontal ScrollView. When tabs fit
                // within the screen, Spacer pushes them to the trailing
                // edge; when they overflow, the ScrollView lets them
                // scroll left.
                GeometryReader { geo in
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            Spacer(minLength: 0)
                            ForEach(terminal.windows) { w in
                                Button(action: { Task { try? await services.api.tmuxSelect(index: w.index) } }) {
                                    Text(w.name)
                                        .font(Font.app(13, weight: w.active ? .heavy : .semibold))
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 6)
                                        .background(tabBg(w))
                                        .foregroundStyle(w.active ? .white : .white.opacity(0.55))
                                        .overlay(alignment: .bottom) {
                                            Rectangle()
                                                .fill(w.active ? Color(hex: "#ebdbb2") : Color.clear)
                                                .frame(height: 2)
                                        }
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
                        // Force HStack to be at least the available
                        // width so Spacer has room to push tabs right.
                        .frame(minWidth: geo.size.width, alignment: .trailing)
                    }
                }
                .frame(height: 38)
                .background(theme.resolvedSurface)
            }

            ZStack(alignment: .trailing) {
                TermHost(host: services.serverHost,
                         autoFocus: terminal.wasKeyboardOpenAtClose,
                         bgColor: UIColor(theme.resolvedSurface),
                         font: fonts.font(),
                         onSwipe: switchTmuxWindow(by:),
                         onMounted: { tv in
                             terminal.dismissKeyboard = { [weak tv] in
                                 _ = tv?.resignFirstResponder()
                             }
                             // Scroll to live edge on (re)open so user
                             // doesn't land mid-scrollback.
                             DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak tv] in
                                 tv?.scrollDown(lines: tv?.getTerminal().rows ?? 0)
                             }
                         })
                    .background(theme.resolvedSurface)
                ScrollZoneOverlay()
                    .frame(width: 56)
            }
        }
        .onDisappear {
            // Capture keyboard state at the moment of close so the
            // next open can decide whether to re-focus and bring the
            // keyboard back (matches React's wasKbOpenAtCloseRef).
            terminal.wasKeyboardOpenAtClose = terminal.keyboardOpen
        }
        .padding(.bottom, bottomInset)
        .background(theme.resolvedSurface)
        .ignoresSafeArea(.container, edges: .bottom)
        .overlay(alignment: .bottomTrailing) {
            if terminal.keyboardOpen {
                Button(action: dismissKeyboard) {
                    Image(systemName: "keyboard.chevron.compact.down")
                        .font(Font.app(16, weight: .bold))
                        .frame(width: 44, height: 44)
                        .foregroundStyle(.white)
                        .background(.black.opacity(0.7))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, 12)
                .padding(.bottom, terminal.keyboardHeight + 12)
            }
        }
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

    private func dismissKeyboard() {
        // Global sendAction didn't route correctly to SwiftTerm's
        // UIScrollView-based UIKeyInput conformance. Call resign
        // directly on the captured TerminalView reference.
        terminal.dismissKeyboard?()
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
        let hex = terminal.resolveColor(w.name)
        if w.active {
            // Active: bright tint or strong neutral so the underline +
            // bg combo is unmistakable against the panel bg.
            if let h = hex { return SwiftUI.Color(hex: h).opacity(0.7) }
            return SwiftUI.Color.white.opacity(0.22)
        }
        if let h = hex { return SwiftUI.Color(hex: h).darken(0.55).opacity(0.5) }
        return SwiftUI.Color.white.opacity(0.05)
    }
}

/// SwiftTerm subclass that overrides paste(_:) to a no-op. SwiftTerm's
/// implementation reads UIPasteboard.general.string and sends it
/// through to the PTY — iOS's Universal Clipboard auto-paste was
/// firing this without any user tap. paste(_:) is `open` in SwiftTerm
/// so this override is allowed (method_setImplementation swizzling the
/// same selector wasn't taking; subclass is more reliable).
extension UIColor {
    static func lerp(from a: UIColor, to b: UIColor, t: CGFloat) -> UIColor {
        var ar: CGFloat = 0, ag: CGFloat = 0, ab: CGFloat = 0, aa: CGFloat = 0
        var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
        a.getRed(&ar, green: &ag, blue: &ab, alpha: &aa)
        b.getRed(&br, green: &bg, blue: &bb, alpha: &ba)
        return UIColor(red: ar + (br - ar) * t,
                       green: ag + (bg - ag) * t,
                       blue: ab + (bb - ab) * t,
                       alpha: aa + (ba - aa) * t)
    }
    func isApproximatelyEqual(to other: UIColor) -> Bool {
        var ar: CGFloat = 0, ag: CGFloat = 0, ab: CGFloat = 0, aa: CGFloat = 0
        var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
        getRed(&ar, green: &ag, blue: &ab, alpha: &aa)
        other.getRed(&br, green: &bg, blue: &bb, alpha: &ba)
        return abs(ar - br) < 0.005 && abs(ag - bg) < 0.005 && abs(ab - bb) < 0.005 && abs(aa - ba) < 0.005
    }
}

final class NoPasteTerminalView: SwiftTerm.TerminalView {
    /// Set true while a swipe-tab gesture is in progress. Blocks all
    /// outbound terminal data (copy/paste round-trips, mouse-drag
    /// selection forwarding, anything SwiftTerm tries to send to the
    /// PTY) so a horizontal swipe can't dump screen contents into the
    /// shell.
    var swipeInProgress: Bool = false

    override func paste(_ sender: Any?) { /* swallow */ }
    override func copy(_ sender: Any?) { /* swallow */ }
    override func insertText(_ text: String) {
        if swipeInProgress { return }
        // Allow single Enter — iOS keyboard sends "\n" / "\r" / "\r\n".
        if text == "\n" || text == "\r" || text == "\r\n" {
            super.insertText(text)
            return
        }
        // Bulk insert (paste): drop.
        if text.count > 4 || text.contains("\n") || text.contains("\r") {
            NSLog("[NoPaste] insertText DROPPED len=\(text.count): \(text.prefix(60).debugDescription)")
            return
        }
        super.insertText(text)
    }
    /// Last-line gate: SwiftTerm's send(source:data:) is the single
    /// exit point for all data heading to the PTY (selection mouse
    /// forwarding included). Drop anything during a swipe.
    override func send(source: Terminal, data: ArraySlice<UInt8>) {
        if swipeInProgress {
            NSLog("[NoPaste] send DROPPED \(data.count) bytes: \(Array(data.prefix(40)))")
            return
        }
        // Diagnostic: log any unusually large send (>32 bytes is suspicious for keystrokes).
        if data.count > 32 {
            NSLog("[NoPaste] send LARGE \(data.count) bytes: \(String(bytes: Array(data.prefix(80)), encoding: .utf8) ?? "<binary>")")
        }
        super.send(source: source, data: data)
    }
}

/// SwiftTerm host wired to the server's `/ws/terminal` PTY endpoint.
/// Receives raw bytes (ANSI escape codes), feeds them to SwiftTerm's
/// emulator. Sends user keypresses back as bytes.
struct TermHost: UIViewRepresentable {
    let host: String
    let autoFocus: Bool
    let bgColor: UIColor
    let font: UIFont
    let onSwipe: (Int) -> Void  // called with -1 (prev) or +1 (next)
    let onMounted: (SwiftTerm.TerminalView) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        let tv = NoPasteTerminalView(frame: .zero)
        tv.pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [])
        tv.terminalDelegate = context.coordinator
        tv.backgroundColor = bgColor
        tv.nativeForegroundColor = UIColor(red: 0xeb/255.0, green: 0xdb/255.0, blue: 0xb2/255.0, alpha: 1)
        tv.nativeBackgroundColor = bgColor
        tv.font = font
        context.coordinator.onSwipe = onSwipe
        context.coordinator.attach(tv: tv, host: host)
        let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.onSwipePan(_:)))
        pan.delegate = context.coordinator
        pan.cancelsTouchesInView = false
        pan.delaysTouchesBegan = false
        pan.delaysTouchesEnded = false
        tv.addGestureRecognizer(pan)
        // Disable SwiftTerm's own pan recognizers — its panMouseGesture
        // forwards drags as SGR mouse sequences to the PTY (the source
        // of the swipe-paste bug). panSelectionGesture would copy to
        // UIPasteboard.
        // SwiftTerm adds panMouseGesture LATER when tmux turns mouse
        // mode on, so a one-time disable at init misses it. Use a
        // recurring 0.5s tick to keep nuking newly-added pans.
        context.coordinator.startPanKiller(on: tv, ourPan: pan)
        if autoFocus {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak tv] in
                _ = tv?.becomeFirstResponder()
            }
        }
        onMounted(tv)
        return tv
    }

    func updateUIView(_ uiView: SwiftTerm.TerminalView, context: Context) {
        context.coordinator.ensureConnected(host: host)
        if uiView.font != font { uiView.font = font }
        context.coordinator.animateBg(to: bgColor, on: uiView)
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
        private var panKillerTimer: Timer?
        private var bgAnimLink: CADisplayLink?
        private var bgAnimStart: CFTimeInterval = 0
        private var bgAnimFrom: UIColor = .black
        private var bgAnimTo: UIColor = .black
        private weak var bgAnimView: SwiftTerm.TerminalView?
        private var lastBg: UIColor?

        func animateBg(to target: UIColor, on view: SwiftTerm.TerminalView) {
            // Skip if we're already at (or animating to) this color.
            if let last = lastBg, last.isApproximatelyEqual(to: target) { return }
            lastBg = target
            // Cancel any running animation so the new tween starts fresh.
            bgAnimLink?.invalidate()
            bgAnimFrom = view.nativeBackgroundColor ?? target
            bgAnimTo = target
            bgAnimView = view
            bgAnimStart = CACurrentMediaTime()
            let link = CADisplayLink(target: self, selector: #selector(tickBgAnim))
            link.add(to: .main, forMode: .common)
            bgAnimLink = link
        }

        @objc private func tickBgAnim() {
            guard let view = bgAnimView else { bgAnimLink?.invalidate(); return }
            let dur: CFTimeInterval = 0.4
            let t = min(1, max(0, (CACurrentMediaTime() - bgAnimStart) / dur))
            // cubic-bezier(0.25, 0.1, 0.25, 1.0) — same curve body uses.
            let eased = bezier(t: t, p1x: 0.25, p1y: 0.1, p2x: 0.25, p2y: 1.0)
            let c = UIColor.lerp(from: bgAnimFrom, to: bgAnimTo, t: CGFloat(eased))
            view.nativeBackgroundColor = c
            view.backgroundColor = c
            view.setNeedsDisplay()
            if t >= 1 {
                bgAnimLink?.invalidate()
                bgAnimLink = nil
            }
        }

        private func bezier(t: Double, p1x: Double, p1y: Double, p2x: Double, p2y: Double) -> Double {
            // Solve the cubic-bezier x(s) = t via Newton's method, then
            // evaluate y(s).
            func bez(_ s: Double, _ a: Double, _ b: Double) -> Double {
                let u = 1 - s
                return 3 * u * u * s * a + 3 * u * s * s * b + s * s * s
            }
            func bezDeriv(_ s: Double, _ a: Double, _ b: Double) -> Double {
                let u = 1 - s
                return 3 * u * u * a + 6 * u * s * (b - a) + 3 * s * s * (1 - b)
            }
            var s = t
            for _ in 0..<6 {
                let dx = bez(s, p1x, p2x) - t
                if abs(dx) < 1e-4 { break }
                let dxds = bezDeriv(s, p1x, p2x)
                if abs(dxds) < 1e-6 { break }
                s -= dx / dxds
            }
            return bez(s, p1y, p2y)
        }

        func startPanKiller(on tv: UIView, ourPan: UIGestureRecognizer) {
            panKillerTimer?.invalidate()
            // Re-disable SwiftTerm's pans every 0.5s. They get re-added
            // when tmux toggles mouse mode; without re-checking, the
            // newly-added pan forwards drag-as-mouse to the PTY.
            panKillerTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak tv, weak ourPan] _ in
                guard let tv else { return }
                for gr in tv.gestureRecognizers ?? [] where gr !== ourPan && gr is UIPanGestureRecognizer {
                    gr.isEnabled = false
                }
            }
            panKillerTimer?.fire()
        }

        // Don't run simultaneously with SwiftTerm's gestures — its
        // selection-pan was activating on every swipe, copying whatever
        // was under the finger to the pasteboard, then iOS Universal
        // Clipboard would auto-paste it back into the PTY.
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            false
        }

        // Only begin if the initial motion is dominantly horizontal —
        // vertical pans go to SwiftTerm (selection / native scroll).
        // Lower threshold (any horizontal velocity, just direction-lock)
        // since SwiftTerm's panMouseGesture is disabled, our pan doesn't
        // fight anything else for vertical motion.
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let pan = g as? UIPanGestureRecognizer, let view = pan.view else { return false }
            let v = pan.velocity(in: view)
            return abs(v.x) > abs(v.y)
        }

        @objc func onSwipePan(_ g: UIPanGestureRecognizer) {
            guard let view = g.view as? NoPasteTerminalView else { return }
            switch g.state {
            case .began:
                swipeStart = g.location(in: view)
                view.swipeInProgress = true
            case .ended:
                let start = swipeStart
                swipeStart = nil
                // Keep PTY blocked until next runloop tick so any
                // SwiftTerm cleanup (mouse-up forwarding) drops too.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    view.swipeInProgress = false
                }
                guard let s = start else { return }
                let end = g.location(in: view)
                let dx = end.x - s.x, dy = end.y - s.y
                guard abs(dx) > 60, abs(dx) > abs(dy) * 1.5 else { return }
                onSwipe?(dx > 0 ? -1 : 1)
            case .cancelled, .failed:
                swipeStart = nil
                view.swipeInProgress = false
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
            // Hard gate: drop any send while a swipe-tab is in flight.
            // Both SwiftTerm send paths (send(data:) and send(source:data:))
            // funnel here, so this is the single chokepoint.
            if let v = source as? NoPasteTerminalView, v.swipeInProgress {
                NSLog("[NoPaste] delegate.send DROPPED \(data.count) bytes during swipe")
                return
            }
            // Heuristic: drop any large send that's clearly not a keystroke
            // (single-press keys are 1-3 bytes; cursor/PFn keys up to ~6).
            // The auto-paste was emitting 100+ byte chunks of screen content.
            if data.count > 16 {
                NSLog("[NoPaste] delegate.send DROPPED suspicious large send: \(data.count) bytes")
                return
            }
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
