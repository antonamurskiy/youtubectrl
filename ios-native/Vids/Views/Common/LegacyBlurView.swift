import SwiftUI
import UIKit

/// SwiftUI-friendly UIVisualEffectView wrapper. Use this instead of
/// `.background(.thinMaterial)` when you need a blur OVER scrollable
/// content — iOS 26's SwiftUI Materials apply Liquid Glass lensing
/// that visually distorts cells passing underneath. UIBlurEffect is
/// the pre-iOS-26 blur with no lensing.
struct LegacyBlurView: UIViewRepresentable {
    let style: UIBlurEffect.Style
    func makeUIView(context: Context) -> UIVisualEffectView {
        UIVisualEffectView(effect: UIBlurEffect(style: style))
    }
    func updateUIView(_ uiView: UIVisualEffectView, context: Context) {
        uiView.effect = UIBlurEffect(style: style)
    }
}
