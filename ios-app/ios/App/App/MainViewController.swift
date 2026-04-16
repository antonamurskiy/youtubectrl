import UIKit
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
}
