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
        uiView.setStoryboard(playback.storyboard)
    }
}

final class ScrubberUIView: UIView {
    private let track = CAShapeLayer()
    private let fill = CAShapeLayer()
    private let thumb = CAShapeLayer()
    private let chapters = CAShapeLayer()
    private let previewLayer = CALayer()
    private let previewLabel: UILabel = {
        let l = UILabel()
        l.font = .monospacedSystemFont(ofSize: 11, weight: .semibold)
        l.textColor = .white
        l.textAlignment = .center
        l.layer.cornerRadius = 3
        l.layer.masksToBounds = true
        l.backgroundColor = UIColor(white: 0, alpha: 0.85)
        l.isHidden = true
        return l
    }()
    private var displayLink: CADisplayLink?
    private var playback: PlaybackStore?
    private var clockOffset: Double = 0
    private var dragging = false
    private var dragPct: Double = 0
    private var storyboard: ApiClient.Storyboard?
    private var pageImages: [Int: UIImage] = [:]
    private var pageInFlight: Set<Int> = []
    private let previewView = UIImageView()
    var onSeek: ((Double) -> Void)?

    func setStoryboard(_ sb: ApiClient.Storyboard?) {
        // Reset cache when switching storyboards.
        if sb?.url != storyboard?.url {
            pageImages.removeAll()
            pageInFlight.removeAll()
        }
        storyboard = sb
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.addSublayer(track)
        layer.addSublayer(fill)
        layer.addSublayer(chapters)
        layer.addSublayer(thumb)
        chapters.fillColor = UIColor.white.withAlphaComponent(0.6).cgColor
        previewView.isHidden = true
        previewView.contentMode = .scaleAspectFill
        previewView.clipsToBounds = true
        previewView.layer.cornerRadius = 4
        previewView.layer.borderColor = UIColor.white.withAlphaComponent(0.5).cgColor
        previewView.layer.borderWidth = 1
        addSubview(previewView)
        addSubview(previewLabel)
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

        // Chapter markers — vertical 2pt-wide ticks at each chapter
        // start. Skipped for live streams (durations are virtual).
        if let sb = storyboard, let chs = sb.chapters, !chs.isEmpty, pb.duration > 0, !pb.isLive {
            let path = UIBezierPath()
            for c in chs {
                guard let start = c.start, start > 0, start < pb.duration else { continue }
                let p = start / pb.duration
                let x = r.minX + r.width * p
                path.append(UIBezierPath(rect: CGRect(x: x - 1, y: r.minY, width: 2, height: r.height)))
            }
            chapters.path = path.cgPath
        } else {
            chapters.path = nil
        }

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
        case .began:
            dragging = true; dragPct = pct
            previewLabel.isHidden = false
            previewView.isHidden = false
        case .changed:
            dragPct = pct
            updatePreviewLabel()
            updateStoryboardTile()
        case .ended, .cancelled:
            dragging = false
            previewLabel.isHidden = true
            previewView.isHidden = true
            onSeek?(pct)
        default: break
        }
        setNeedsLayout()
    }

    private func updateStoryboardTile() {
        guard let sb = storyboard, let urlTpl = sb.url,
              let cols = sb.cols, cols > 0,
              let rows = sb.rows, rows > 0,
              let interval = sb.interval, interval > 0,
              let tileW = sb.width, let tileH = sb.height,
              let pb = playback, pb.duration > 0 else {
            previewView.image = nil
            return
        }
        let target = pb.duration * dragPct
        let frameIndex = Int(target / interval)
        let perPage = cols * rows
        let pageIndex = frameIndex / perPage
        let frameOnPage = frameIndex % perPage
        let col = frameOnPage % cols
        let row = frameOnPage / cols

        let r = bounds.insetBy(dx: 12, dy: 0)
        let cx = r.minX + r.width * dragPct
        let prevW: CGFloat = 132, prevH = prevW * CGFloat(tileH) / CGFloat(tileW)
        previewView.frame = CGRect(x: max(8, min(bounds.width - prevW - 8, cx - prevW / 2)),
                                   y: -prevH - 24,
                                   width: prevW, height: prevH)

        if let img = pageImages[pageIndex] {
            previewView.image = cropTile(img, col: col, row: row, tileW: tileW, tileH: tileH)
        } else {
            previewView.image = nil
            fetchPage(template: urlTpl, page: pageIndex)
        }
    }

    private func cropTile(_ image: UIImage, col: Int, row: Int, tileW: Int, tileH: Int) -> UIImage? {
        let scale = image.scale
        let rect = CGRect(x: CGFloat(col * tileW) * scale,
                          y: CGFloat(row * tileH) * scale,
                          width: CGFloat(tileW) * scale,
                          height: CGFloat(tileH) * scale)
        guard let cg = image.cgImage?.cropping(to: rect) else { return nil }
        return UIImage(cgImage: cg, scale: scale, orientation: image.imageOrientation)
    }

    private func fetchPage(template: String, page: Int) {
        guard !pageInFlight.contains(page) else { return }
        pageInFlight.insert(page)
        let urlStr = template.replacingOccurrences(of: "M$M.jpg", with: "M\(page).jpg")
        guard let url = URL(string: urlStr) else { return }
        Task.detached { [weak self] in
            let (data, _) = (try? await URLSession.shared.data(from: url)) ?? (Data(), URLResponse())
            guard let img = UIImage(data: data) else { return }
            await MainActor.run {
                guard let self else { return }
                self.pageImages[page] = img
                self.pageInFlight.remove(page)
                if self.dragging { self.updateStoryboardTile() }
            }
        }
    }

    private func updatePreviewLabel() {
        guard let pb = playback, pb.duration > 0 else { return }
        let target = pb.duration * dragPct
        previewLabel.text = pb.isLive
            ? "-\(formatTime(pb.duration - target))"
            : formatTime(target)
        let r = bounds.insetBy(dx: 12, dy: 0)
        let cx = r.minX + r.width * dragPct
        let labelW: CGFloat = 60, labelH: CGFloat = 18
        previewLabel.frame = CGRect(x: cx - labelW / 2, y: -labelH - 4, width: labelW, height: labelH)
    }

    private func formatTime(_ s: Double) -> String {
        let total = Int(s.rounded())
        let h = total / 3600, m = (total % 3600) / 60, sec = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }

    @objc private func onTap(_ g: UITapGestureRecognizer) {
        let p = g.location(in: self)
        let r = bounds.insetBy(dx: 12, dy: 0)
        let pct = max(0, min(1, (p.x - r.minX) / r.width))
        onSeek?(pct)
    }
}
