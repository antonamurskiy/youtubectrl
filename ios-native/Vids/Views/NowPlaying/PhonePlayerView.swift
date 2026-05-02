import SwiftUI
import UIKit

/// Wraps AVPlayerHost.containerView so the AVPlayerLayer lives inside
/// SwiftUI's view tree. Used when phone-sync mode is active.
struct PhonePlayerView: UIViewRepresentable {
    let host: AVPlayerHost
    func makeUIView(context: Context) -> UIView {
        host.containerView.removeFromSuperview()
        let wrap = UIView()
        wrap.backgroundColor = .black
        host.containerView.frame = wrap.bounds
        host.containerView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.containerView.isHidden = false
        wrap.addSubview(host.containerView)
        return wrap
    }
    func updateUIView(_ uiView: UIView, context: Context) {
        host.containerView.frame = uiView.bounds
        // Re-attach in case it was moved away (e.g., earlier PiP cycle)
        // and ensure it's visible — earlier "computer mode" fix paused
        // the AVPlayer + isHidden = true; restoring here on every
        // SwiftUI update guarantees phone-mode shows the video.
        if host.containerView.superview !== uiView {
            host.containerView.removeFromSuperview()
            uiView.addSubview(host.containerView)
        }
        host.containerView.isHidden = false
    }
}
