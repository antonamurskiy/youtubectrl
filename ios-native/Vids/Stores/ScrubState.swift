import SwiftUI
import UIKit
import Observation

/// Lifted scrubber preview state — published by ScrubberView during a
/// drag and rendered by RootView as a sibling overlay of the
/// NowPlayingBar. This is how Apple TV / AVKit's scrub preview works:
/// the thumbnail tile lives ABOVE the controls bar in the view stack,
/// not inside it, so the bar's `glassEffect(in: shape)` clip mask
/// doesn't eat the floating preview at negative y.
@Observable
final class ScrubState {
    var active: Bool = false
    /// 0..1 along the scrubber.
    var pct: Double = 0
    /// Storyboard tile cropped for the current frame.
    var image: UIImage? = nil
    /// Time label ("3:42" or "-1:23" for live).
    var label: String = ""
    /// Source tile aspect (width / height) so the display frame can
    /// match exactly — different streams give different aspects
    /// (16:9, 4:3, vertical shorts) and a hardcoded 16:9 frame leaves
    /// letterbox bars on anything else.
    var aspect: Double = 16.0 / 9.0
}
