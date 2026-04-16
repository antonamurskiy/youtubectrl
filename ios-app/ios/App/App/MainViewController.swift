import UIKit
import WebKit
import Capacitor

/// Custom bridge VC that registers our local NativePlayerPlugin at runtime.
///
/// In Capacitor 7 SPM mode, plugins living outside an SPM package (like ours
/// inside the App target) aren't discovered automatically. Registering here
/// makes `Capacitor.Plugins.NativePlayer` visible to the web side.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativePlayerPlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Force the WKWebView's scroll view to bounce at both ends so the
        // native iOS overscroll rubber-band works at the top (feels "native"
        // when the user tries to pull past the top of the page).
        if let wv = self.webView as? WKWebView {
            wv.scrollView.bounces = true
            wv.scrollView.alwaysBounceVertical = true
        }
    }
}
