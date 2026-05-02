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
            if services.phoneMode.mode == .phoneOnly {
                // Use AVPlayer's actual asset duration — playback.duration
                // can be 0 if the server's response didn't carry one
                // (Rumble sometimes), and pct * 0 always lands at zero.
                Task {
                    let assetDur = services.avHost.currentItemDurationSeconds
                    let dur = assetDur > 0 ? assetDur : playback.duration
                    guard dur > 0 else { return }
                    await services.avHost.seek(toSeconds: pct * dur)
                }
            } else {
                let target = pct * (playback.duration > 0 ? playback.duration : 0)
                Task { try? await services.api.seek(target) }
            }
        }
        // Hoist scrub preview into the SwiftUI overlay above NPBar —
        // ScrubberUIView publishes drag state, RootView renders the
        // floating tile (Apple TV / AVKit pattern; no glass-clip
        // issues since the preview lives outside the bar's view tree).
        v.onScrub = { [weak services] active, pct, image, label, aspect, chapter in
            guard let scrub = services?.scrub else { return }
            scrub.active = active
            scrub.pct = pct
            scrub.image = image
            scrub.label = label
            scrub.aspect = aspect
            scrub.chapter = chapter
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
    private var displayLink: CADisplayLink?
    private var playback: PlaybackStore?
    private var clockOffset: Double = 0
    private var dragging = false
    private var dragPct: Double = 0
    private var storyboard: ApiClient.Storyboard?
    private var pageImages: [Int: UIImage] = [:]
    private var pageInFlight: Set<Int> = []
    var onSeek: ((Double) -> Void)?
    /// Publishes scrub state to the SwiftUI overlay (Apple TV pattern).
    /// (active, pct, tileImage, label, aspect, chapterTitle)
    var onScrub: ((Bool, Double, UIImage?, String, Double, String) -> Void)?

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
        // Thumb gets a soft drop shadow + thin stroke so it lifts off
        // the translucent glass bar and reads as a tactile pill.
        thumb.shadowColor = UIColor.black.cgColor
        thumb.shadowOpacity = 0.45
        thumb.shadowRadius = 4
        thumb.shadowOffset = CGSize(width: 0, height: 1)
        thumb.strokeColor = UIColor.white.withAlphaComponent(0.35).cgColor
        thumb.lineWidth = 1
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
        // Apple Music-style: thin track that grows when dragging.
        let h: CGFloat = dragging ? 8 : 4
        let r = bounds.insetBy(dx: 14, dy: (bounds.height - h) / 2)
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

        // Knob expands when dragging, like Music.app + Now Playing.
        let thumbR: CGFloat = dragging ? 11 : 7
        let cx = r.minX + r.width * pct
        let cy = r.midY
        thumb.path = UIBezierPath(ovalIn: CGRect(x: cx - thumbR, y: cy - thumbR, width: thumbR * 2, height: thumbR * 2)).cgPath
    }

    @objc private func onPan(_ g: UIPanGestureRecognizer) {
        let p = g.location(in: self)
        let r = bounds.insetBy(dx: 14, dy: 0)
        let pct = max(0, min(1, (p.x - r.minX) / r.width))
        switch g.state {
        case .began:
            dragging = true; dragPct = pct
            publishScrub(active: true)
            UIView.animate(withDuration: 0.18,
                           delay: 0,
                           usingSpringWithDamping: 0.85,
                           initialSpringVelocity: 0,
                           options: [.beginFromCurrentState]) { [weak self] in
                self?.layoutIfNeeded()
            }
        case .changed:
            dragPct = pct
            publishScrub(active: true)
        case .ended, .cancelled:
            dragging = false
            publishScrub(active: false)
            onSeek?(pct)
            UIView.animate(withDuration: 0.22,
                           delay: 0,
                           usingSpringWithDamping: 0.85,
                           initialSpringVelocity: 0,
                           options: [.beginFromCurrentState]) { [weak self] in
                self?.layoutIfNeeded()
            }
        default: break
        }
        setNeedsLayout()
    }

    /// Compute the storyboard tile + label for the current dragPct and
    /// hand off to the SwiftUI overlay via `onScrub`.
    private func publishScrub(active: Bool) {
        guard active else {
            onScrub?(false, dragPct, nil, "", 16.0/9.0, "")
            return
        }
        guard let pb = playback, pb.duration > 0 else {
            onScrub?(true, dragPct, nil, "", 16.0/9.0, "")
            return
        }
        let target = pb.duration * dragPct
        let label = pb.isLive ? "-\(formatTime(pb.duration - target))" : formatTime(target)
        // Chapter under thumb: pick the latest chapter whose start ≤ target.
        var chapter = ""
        if let chs = storyboard?.chapters, !chs.isEmpty, !pb.isLive {
            for c in chs where (c.start ?? 0) <= target {
                if let t = c.title, !t.isEmpty { chapter = t }
            }
        }
        var image: UIImage? = nil
        var aspect: Double = 16.0/9.0
        if let sb = storyboard, let urlTpl = sb.url,
           let cols = sb.cols, cols > 0,
           let rows = sb.rows, rows > 0,
           let interval = sb.interval, interval > 0 {
            let frameIndex = Int(target / interval)
            let perPage = cols * rows
            let pageIndex = frameIndex / perPage
            let frameOnPage = frameIndex % perPage
            let col = frameOnPage % cols
            let row = frameOnPage / cols
            if let img = pageImages[pageIndex], let cg = img.cgImage {
                // Derive actual tile dimensions from the fetched page
                // image — sb.width/height from the server have been
                // unreliable; the page is exactly cols × rows tiles, so
                // pageW/cols × pageH/rows is the source of truth.
                let pageW = cg.width
                let pageH = cg.height
                let realTileW = pageW / cols
                let realTileH = pageH / rows
                aspect = Double(realTileW) / Double(realTileH)
                image = cropTile(img, col: col, row: row,
                                 tileW: realTileW, tileH: realTileH)
            } else {
                fetchPage(template: urlTpl, page: pageIndex)
            }
        }
        onScrub?(true, dragPct, image, label, aspect, chapter)
    }

    private func cropTile(_ image: UIImage, col: Int, row: Int, tileW: Int, tileH: Int) -> UIImage? {
        // YouTube storyboards: server's sb.width/height are in PIXELS
        // and so is the page image we fetched directly via URL (scale
        // = 1). The previous `* image.scale` multiplier double-applied
        // the device scale, sliding the crop into the wrong tile and
        // showing a fragment of the next frame — what looked like
        // "cut-off" image.
        let rect = CGRect(x: CGFloat(col * tileW),
                          y: CGFloat(row * tileH),
                          width: CGFloat(tileW),
                          height: CGFloat(tileH))
        guard let cg = image.cgImage?.cropping(to: rect) else { return nil }
        return UIImage(cgImage: cg, scale: 1, orientation: image.imageOrientation)
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
                if self.dragging { self.publishScrub(active: true) }
            }
        }
    }

    private func formatTime(_ s: Double) -> String {
        let total = Int(s.rounded())
        let h = total / 3600, m = (total % 3600) / 60, sec = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }

    @objc private func onTap(_ g: UITapGestureRecognizer) {
        let p = g.location(in: self)
        let r = bounds.insetBy(dx: 14, dy: 0)
        let pct = max(0, min(1, (p.x - r.minX) / r.width))
        onSeek?(pct)
    }
}
