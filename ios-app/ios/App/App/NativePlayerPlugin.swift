import Foundation
import Capacitor
import AVKit
import AVFoundation
import UIKit

/**
 * Native video player + Picture-in-Picture support for YouTubeCtrl.
 *
 * Web JS calls methods on `NativePlayer` (registered below). The plugin owns
 * an AVPlayer and a hidden AVPlayerLayer that drives an AVPictureInPictureController.
 *
 * On iOS 15+ the phone's system lock-screen controls + PiP just work as long as
 * the audio session is set to .playback (done in AppDelegate).
 */
@objc(NativePlayerPlugin)
public class NativePlayerPlugin: CAPPlugin, CAPBridgedPlugin, AVPictureInPictureControllerDelegate {
    public let identifier = "NativePlayerPlugin"
    public let jsName = "NativePlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise)
    ]

    private var player: AVPlayer?
    private var playerLayer: AVPlayerLayer?
    private var playerContainer: UIView?
    private var pipController: AVPictureInPictureController?
    private var timeObserver: Any?

    private func ensureLayer() {
        guard playerLayer == nil, let wv = self.bridge?.webView else { return }
        // A 1x1 transparent view that hosts the player layer so iOS has something
        // to attach PiP to. Placed behind the WKWebView so it's invisible.
        let container = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        container.isUserInteractionEnabled = false
        container.backgroundColor = .clear
        wv.superview?.insertSubview(container, belowSubview: wv)
        self.playerContainer = container

        let layer = AVPlayerLayer()
        layer.frame = container.bounds
        layer.videoGravity = .resizeAspect
        container.layer.addSublayer(layer)
        self.playerLayer = layer
    }

    private func installPipController() {
        guard let layer = playerLayer,
              AVPictureInPictureController.isPictureInPictureSupported() else { return }
        if pipController != nil { return }
        let ctrl = AVPictureInPictureController(playerLayer: layer)
        ctrl?.delegate = self
        if #available(iOS 14.2, *) {
            ctrl?.canStartPictureInPictureAutomaticallyFromInline = true
        }
        self.pipController = ctrl
    }

    @objc func load(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"),
              let url = URL(string: urlStr) else {
            call.reject("url required")
            return
        }
        let position = call.getDouble("position") ?? 0
        let autoplay = call.getBool("autoplay") ?? true
        DispatchQueue.main.async {
            self.ensureLayer()
            let item = AVPlayerItem(url: url)
            if self.player == nil {
                self.player = AVPlayer(playerItem: item)
            } else {
                self.player?.replaceCurrentItem(with: item)
            }
            self.playerLayer?.player = self.player
            if position > 0 {
                self.player?.seek(to: CMTime(seconds: position, preferredTimescale: 600))
            }
            self.installPipController()
            if autoplay { self.player?.play() }
            self.notifyListeners("loaded", data: ["url": urlStr])
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player?.play()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player?.pause()
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pipController?.stopPictureInPicture()
            self.player?.pause()
            self.player?.replaceCurrentItem(with: nil)
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        guard let position = call.getDouble("position") else {
            call.reject("position required")
            return
        }
        DispatchQueue.main.async {
            self.player?.seek(to: CMTime(seconds: position, preferredTimescale: 600))
            call.resolve()
        }
    }

    @objc func setRate(_ call: CAPPluginCall) {
        guard let rate = call.getFloat("rate") else {
            call.reject("rate required")
            return
        }
        DispatchQueue.main.async {
            self.player?.rate = rate
            call.resolve()
        }
    }

    @objc func startPip(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let ctrl = self.pipController else { call.reject("pip not ready"); return }
            if ctrl.isPictureInPicturePossible {
                ctrl.startPictureInPicture()
                call.resolve()
            } else {
                call.reject("pip not possible yet — try after playback starts")
            }
        }
    }

    @objc func stopPip(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pipController?.stopPictureInPicture()
            call.resolve()
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let time = self.player?.currentTime().seconds ?? 0
            let duration = self.player?.currentItem?.duration.seconds ?? 0
            let rate = self.player?.rate ?? 0
            call.resolve([
                "position": time.isFinite ? time : 0,
                "duration": duration.isFinite ? duration : 0,
                "rate": rate,
                "paused": rate == 0
            ])
        }
    }

    // MARK: - PiP delegate

    public func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
        notifyListeners("pipStarted", data: [:])
    }
    public func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
        notifyListeners("pipStopped", data: [:])
    }
}
