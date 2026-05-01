import SwiftUI
import UIKit

/// CADisplayLink-driven scrubber. Interpolates `position` between WS
/// ticks using wall-clock so the thumb glides at 120Hz on ProMotion
/// instead of stepping in 1s jumps.
struct ScrubberView: UIViewRepresentable {
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @Environment(ThemeStore.self) private var theme

    func makeUIView(context: Context) -> ScrubberUIView {
        let v = ScrubberUIView()
        v.onSeek = { [weak services] pct in
            guard let services else { return }
            let target = pct * (Double(playback.duration > 0 ? playback.duration : 0))
            Task { try? await services.api.seek(target) }
        }
        return v
    }

    func updateUIView(_ uiView: ScrubberUIView, context: Context) {
        uiView.update(playback: playback,
                      clockOffset: services.ws.clockOffset,
                      fillColor: UIColor(theme.resolvedFill),
                      trackColor: UIColor(theme.resolvedTrack))
    }
}

final class ScrubberUIView: UIView {
    private let track = CAShapeLayer()
    private let fill = CAShapeLayer()
    private let thumb = CAShapeLayer()
    private var displayLink: CADisplayLink?
    private var playback: PlaybackStore?
    private var clockOffset: Double = 0
    private var dragging = false
    private var dragPct: Double = 0
    var onSeek: ((Double) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.addSublayer(track)
        layer.addSublayer(fill)
        layer.addSublayer(thumb)
        backgroundColor = .clear
        let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
        addGestureRecognizer(pan)
        let tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
        addGestureRecognizer(tap)
    }
    required init?(coder: NSCoder) { fatalError() }

    func update(playback: PlaybackStore, clockOffset: Double, fillColor: UIColor, trackColor: UIColor) {
        self.playback = playback
        self.clockOffset = clockOffset
        track.fillColor = trackColor.cgColor
        fill.fillColor = fillColor.cgColor
        thumb.fillColor = fillColor.cgColor
        ensureLink()
        setNeedsLayout()
    }

    private func ensureLink() {
        guard displayLink == nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(tick))
        l.add(to: .main, forMode: .common)
        displayLink = l
    }

    deinit { displayLink?.invalidate() }

    @objc private func tick() { setNeedsLayout() }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let pb = playback else { return }
        let h: CGFloat = 4
        let r = bounds.insetBy(dx: 12, dy: (bounds.height - h) / 2)
        track.path = UIBezierPath(roundedRect: r, cornerRadius: h/2).cgPath

        let pct: Double
        if dragging {
            pct = dragPct
        } else {
            let now = Date().timeIntervalSince1970 * 1000
            let pos = pb.interpolatedPosition(now: now, clockOffset: clockOffset)
            pct = pb.duration > 0 ? min(max(pos / pb.duration, 0), 1) : 0
        }
        let fillRect = CGRect(x: r.minX, y: r.minY, width: r.width * pct, height: r.height)
        fill.path = UIBezierPath(roundedRect: fillRect, cornerRadius: h/2).cgPath

        let thumbR: CGFloat = 8
        let cx = r.minX + r.width * pct
        let cy = r.midY
        thumb.path = UIBezierPath(ovalIn: CGRect(x: cx - thumbR, y: cy - thumbR, width: thumbR * 2, height: thumbR * 2)).cgPath
    }

    @objc private func onPan(_ g: UIPanGestureRecognizer) {
        let p = g.location(in: self)
        let r = bounds.insetBy(dx: 12, dy: 0)
        let pct = max(0, min(1, (p.x - r.minX) / r.width))
        switch g.state {
        case .began: dragging = true; dragPct = pct
        case .changed: dragPct = pct
        case .ended, .cancelled:
            dragging = false
            onSeek?(pct)
        default: break
        }
        setNeedsLayout()
    }

    @objc private func onTap(_ g: UITapGestureRecognizer) {
        let p = g.location(in: self)
        let r = bounds.insetBy(dx: 12, dy: 0)
        let pct = max(0, min(1, (p.x - r.minX) / r.width))
        onSeek?(pct)
    }
}
