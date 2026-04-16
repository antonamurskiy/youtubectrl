import Foundation
import Capacitor
import AVKit
import AVFoundation
import MediaPlayer
import UIKit

/**
 * Native video player + PiP + system integration for YouTubeCtrl.
 *
 * Responsibilities:
 *   - AVPlayer playback (hand-off from the web UI for true Picture-in-Picture)
 *   - MPNowPlayingInfoCenter metadata (lock screen / Control Center artwork)
 *   - MPRemoteCommandCenter (AirPods taps, lock-screen buttons, media keys)
 *   - AirPlay route picker (MPVolumeView's AirPlay button, presented over webview)
 *   - UIApplication.isIdleTimerDisabled while playing (screen never sleeps)
 *
 * Web JS calls methods on `NativePlayer` (registered below). Events are sent
 * back via `notifyListeners`.
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
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showAirPlayPicker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise)
    ]

    private var player: AVPlayer?
    private var playerLayer: AVPlayerLayer?
    private var playerContainer: UIView?
    private var pipController: AVPictureInPictureController?
    private var timeObserver: Any?
    private var currentArtworkUrl: String?
    private var currentArtwork: MPMediaItemArtwork?
    private var remoteCommandsInstalled = false
    private var hiddenRoutePicker: AVRoutePickerView?

    // Silent keep-alive player — runs in the background so the audio session
    // stays active and iOS shows Now Playing even when the actual audio is
    // coming from the desktop (mpv). Plays a silent looping track.
    private var silentPlayer: AVPlayer?
    private var silentLooper: Any?

    private func ensureLayer() {
        guard playerLayer == nil, let wv = self.bridge?.webView else { return }
        // A 1x1 transparent view that hosts the player layer so iOS has
        // something to attach PiP to. Placed behind the WKWebView so it's
        // invisible.
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

    private func installRemoteCommands() {
        if remoteCommandsInstalled { return }
        remoteCommandsInstalled = true

        let cmd = MPRemoteCommandCenter.shared()

        cmd.playCommand.isEnabled = true
        cmd.playCommand.addTarget { [weak self] _ in
            self?.player?.play()
            self?.notifyListeners("remotePlay", data: [:])
            self?.updateNowPlayingPlaybackState()
            return .success
        }

        cmd.pauseCommand.isEnabled = true
        cmd.pauseCommand.addTarget { [weak self] _ in
            self?.player?.pause()
            self?.notifyListeners("remotePause", data: [:])
            self?.updateNowPlayingPlaybackState()
            return .success
        }

        cmd.togglePlayPauseCommand.isEnabled = true
        cmd.togglePlayPauseCommand.addTarget { [weak self] _ in
            if let p = self?.player { if p.rate == 0 { p.play() } else { p.pause() } }
            self?.notifyListeners("remoteTogglePlayPause", data: [:])
            self?.updateNowPlayingPlaybackState()
            return .success
        }

        cmd.skipForwardCommand.preferredIntervals = [15]
        cmd.skipForwardCommand.isEnabled = true
        cmd.skipForwardCommand.addTarget { [weak self] _ in
            if let p = self?.player {
                let now = p.currentTime().seconds
                p.seek(to: CMTime(seconds: now + 15, preferredTimescale: 600))
            }
            self?.notifyListeners("remoteSkip", data: ["delta": 15])
            return .success
        }

        cmd.skipBackwardCommand.preferredIntervals = [15]
        cmd.skipBackwardCommand.isEnabled = true
        cmd.skipBackwardCommand.addTarget { [weak self] _ in
            if let p = self?.player {
                let now = p.currentTime().seconds
                p.seek(to: CMTime(seconds: max(0, now - 15), preferredTimescale: 600))
            }
            self?.notifyListeners("remoteSkip", data: ["delta": -15])
            return .success
        }

        cmd.changePlaybackPositionCommand.isEnabled = true
        cmd.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let positionEvent = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.player?.seek(to: CMTime(seconds: positionEvent.positionTime, preferredTimescale: 600))
            self?.notifyListeners("remoteSeek", data: ["position": positionEvent.positionTime])
            return .success
        }
    }

    /// Starts a silent looping audio track so the audio session stays active
    /// and iOS shows the Now Playing widget even when local AVPlayer isn't
    /// playing anything (e.g. audio is actually coming from desktop mpv).
    private func startSilentAudioIfNeeded() {
        if silentPlayer != nil { return }
        // Bundled silent.m4a (served by the web app under /silent.m4a)
        guard let url = URL(string: "http://yuzu.local:3000/silent.m4a") else { return }
        let item = AVPlayerItem(url: url)
        let p = AVQueuePlayer(playerItem: item)
        p.actionAtItemEnd = .none
        if #available(iOS 10.0, *) {
            silentLooper = AVPlayerLooper(player: p, templateItem: item)
        }
        p.volume = 0.0
        p.play()
        silentPlayer = p
    }

    private func updateNowPlayingPlaybackState() {
        guard let p = player else { return }
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = p.currentTime().seconds
        info[MPNowPlayingInfoPropertyPlaybackRate] = p.rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func setIdleTimer(disabled: Bool) {
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = disabled
        }
    }

    // MARK: - Bridged methods

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
            self.installRemoteCommands()
            if autoplay {
                self.player?.play()
                self.setIdleTimer(disabled: true)
            }
            self.notifyListeners("loaded", data: ["url": urlStr])
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player?.play()
            self.setIdleTimer(disabled: true)
            self.updateNowPlayingPlaybackState()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player?.pause()
            self.setIdleTimer(disabled: false)
            self.updateNowPlayingPlaybackState()
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pipController?.stopPictureInPicture()
            self.player?.pause()
            self.player?.replaceCurrentItem(with: nil)
            self.setIdleTimer(disabled: false)
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
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
            self.updateNowPlayingPlaybackState()
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

    @objc func setNowPlaying(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let artist = call.getString("artist") ?? ""
        let artworkUrl = call.getString("artworkUrl")
        let duration = call.getDouble("duration") ?? 0
        let position = call.getDouble("position") ?? 0
        let isLive = call.getBool("isLive") ?? false
        let paused = call.getBool("paused") ?? false

        DispatchQueue.main.async {
            // Make sure remote commands are installed even without an AVPlayer
            self.installRemoteCommands()
            // Keep the audio session active so the lock-screen widget shows up
            // even when local AVPlayer isn't actively playing (desktop mpv).
            self.startSilentAudioIfNeeded()

            // Reflect play/pause state on the widget
            let rate: Float = paused ? 0.0 : (self.player?.rate ?? 1.0)

            var info: [String: Any] = [
                MPMediaItemPropertyTitle: title,
                MPMediaItemPropertyArtist: artist,
                MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
                MPNowPlayingInfoPropertyPlaybackRate: rate,
                MPNowPlayingInfoPropertyIsLiveStream: isLive
            ]
            if duration > 0 && !isLive {
                info[MPMediaItemPropertyPlaybackDuration] = duration
            }
            if let existing = self.currentArtwork,
               artworkUrl == self.currentArtworkUrl {
                info[MPMediaItemPropertyArtwork] = existing
            }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            call.resolve()

            // Fetch and set artwork out of band — don't block on network
            if let urlStr = artworkUrl,
               urlStr != self.currentArtworkUrl,
               let url = URL(string: urlStr) {
                self.currentArtworkUrl = urlStr
                URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
                    guard let self = self, let data = data, let image = UIImage(data: data) else { return }
                    let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                    DispatchQueue.main.async {
                        // Check the URL hasn't changed while we were fetching
                        guard self.currentArtworkUrl == urlStr else { return }
                        self.currentArtwork = artwork
                        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                        info[MPMediaItemPropertyArtwork] = artwork
                        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                    }
                }.resume()
            }
        }
    }

    @objc func clearNowPlaying(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            self.currentArtwork = nil
            self.currentArtworkUrl = nil
            // Stop silent keep-alive track so iOS releases the audio session
            self.silentPlayer?.pause()
            self.silentPlayer = nil
            self.silentLooper = nil
            call.resolve()
        }
    }

    @objc func showAirPlayPicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let wv = self.bridge?.webView else { call.reject("no webview"); return }
            if self.hiddenRoutePicker == nil {
                let picker = AVRoutePickerView(frame: CGRect(x: -100, y: -100, width: 50, height: 50))
                picker.isHidden = true
                wv.superview?.addSubview(picker)
                self.hiddenRoutePicker = picker
            }
            // Programmatically tap the route picker button to open the native sheet.
            if let button = self.hiddenRoutePicker?.subviews.first(where: { $0 is UIButton }) as? UIButton {
                button.sendActions(for: .touchUpInside)
            }
            call.resolve()
        }
    }

    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        self.setIdleTimer(disabled: enabled)
        call.resolve()
    }

    // MARK: - PiP delegate

    public func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
        notifyListeners("pipStarted", data: [:])
    }
    public func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
        notifyListeners("pipStopped", data: [:])
    }
}
