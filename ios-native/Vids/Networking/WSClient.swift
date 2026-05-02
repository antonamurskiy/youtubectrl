import Foundation

enum WSMessage {
    case playback(PlaybackPayload)
    case tmux(TmuxBroadcast)
    case claudeFeed([String])
    case claude(ClaudePayload)
}

final class WSClient {
    var host: String
    private var task: URLSessionWebSocketTask?
    private var session: URLSession
    private var reconnectAttempts = 0
    private var pingState: [Double] = []
    private var pendingPing: Double?
    private(set) var clockOffset: Double = 0

    var onMessage: ((WSMessage) -> Void)?
    var onConnected: ((Bool) -> Void)?

    init(host: String) {
        self.host = host
        // Force the receive callback onto the main queue so PlaybackStore
        // mutations (which back @Observable views) propagate to SwiftUI
        // reliably. Default delegate queue is a background serial queue
        // and off-main @Observable writes silently fail to re-render.
        self.session = URLSession(configuration: .default,
                                  delegate: nil,
                                  delegateQueue: OperationQueue.main)
    }

    func connect() {
        guard task == nil else { return }
        var c = URLComponents()
        c.scheme = "ws"
        let parts = host.split(separator: ":", maxSplits: 1).map(String.init)
        c.host = parts.first
        if parts.count > 1, let port = Int(parts[1]) { c.port = port }
        c.path = "/ws/sync"
        c.queryItems = [URLQueryItem(name: "proto", value: "2")]
        guard let url = c.url else { return }
        task = session.webSocketTask(with: url)
        task?.resume()
        onConnected?(true)
        receiveLoop()
        sendPing()
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let msg):
                self.handle(msg)
                self.receiveLoop()
            case .failure:
                self.onConnected?(false)
                self.task = nil
                let attempt = min(self.reconnectAttempts, 6)
                let delay = min(0.5 * pow(2.0, Double(attempt)), 30)
                self.reconnectAttempts += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.connect() }
            }
        }
    }

    private func handle(_ msg: URLSessionWebSocketTask.Message) {
        guard case .string(let text) = msg, let data = text.data(using: .utf8) else { return }
        guard let any = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = any["type"] as? String else { return }
        switch type {
        case "playback":
            if let payload = try? JSONDecoder().decode(PlaybackPayload.self, from: data) {
                onMessage?(.playback(payload))
            }
        case "tmux":
            let windows = (try? JSONDecoder().decode([String: [TmuxWindow]].self, from: payloadData(any: any, key: "tmuxWindows"))) ?? [:]
            let _ = windows
            if let raw = any["tmuxWindows"] as? [[String: Any]] {
                let windowsData = try? JSONSerialization.data(withJSONObject: raw)
                let decoded = (try? windowsData.flatMap { try JSONDecoder().decode([TmuxWindow].self, from: $0) }) ?? []
                let colors = any["tmuxColors"] as? [String: String]
                onMessage?(.tmux(TmuxBroadcast(windows: decoded, colors: colors)))
            }
        case "claude-feed":
            if let lines = any["lines"] as? [String] { onMessage?(.claudeFeed(lines)) }
        case "claude":
            if let payload = try? JSONDecoder().decode(ClaudePayload.self, from: data) {
                onMessage?(.claude(payload))
            }
        case "pong":
            handlePong(any)
        default: break
        }
    }

    private func payloadData(any: [String: Any], key: String) -> Data {
        if let v = any[key], let d = try? JSONSerialization.data(withJSONObject: v) { return d }
        return Data("[]".utf8)
    }

    private func sendPing() {
        guard let task else { return }
        if pingState.count >= 5 {
            let sorted = pingState.sorted()
            clockOffset = sorted[sorted.count / 2]
            return
        }
        pendingPing = Date().timeIntervalSince1970 * 1000
        let body: [String: Any] = ["type": "ping", "clientTs": pendingPing!]
        if let data = try? JSONSerialization.data(withJSONObject: body),
           let str = String(data: data, encoding: .utf8) {
            task.send(.string(str)) { _ in }
        }
    }

    private func handlePong(_ any: [String: Any]) {
        guard let pending = pendingPing, let serverTs = any["serverTs"] as? Double else { return }
        let now = Date().timeIntervalSince1970 * 1000
        let rtt = now - pending
        let offset = serverTs - pending - rtt / 2
        pingState.append(offset)
        pendingPing = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.sendPing() }
    }

    func send(_ object: [String: Any]) {
        guard let task,
              let data = try? JSONSerialization.data(withJSONObject: object),
              let str = String(data: data, encoding: .utf8) else { return }
        task.send(.string(str)) { _ in }
    }

    func disconnect() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }
}
