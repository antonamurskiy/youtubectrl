import WidgetKit
import SwiftUI

@main
struct YouTubeCtrlWidgetBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 16.1, *) {
            YouTubeCtrlLiveActivity()
        }
    }
}
