import SwiftUI

struct ToastHUD: View {
    @Environment(UIStore.self) private var ui
    @Environment(TerminalStore.self) private var terminal

    var body: some View {
        VStack(spacing: 8) {
            ForEach(terminal.open ? [] : ui.toasts) { t in
                Text(t.text)
                    .font(Font.app(13, weight: .semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.black.opacity(0.85))
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, 60)
        .allowsHitTesting(false)
        .animation(.easeOut(duration: 0.18), value: ui.toasts.count)
    }
}

struct VolumeHUD: View {
    @Environment(UIStore.self) private var ui

    var body: some View {
        if let pulse = ui.volumePulse {
            VStack(spacing: 8) {
                Text("\(pulse.percent)%")
                    .font(Font.app(28, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white)
                Rectangle()
                    .fill(.white.opacity(0.15))
                    .frame(width: 160, height: 4)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(.white)
                            .frame(width: 160 * CGFloat(max(0, min(100, pulse.percent))) / 100, height: 4)
                    }
            }
            .padding(20)
            .background(.black.opacity(0.7))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            .allowsHitTesting(false)
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
    }
}

struct ClaudeFeedView: View {
    @Environment(PushStore.self) private var push
    @Environment(TerminalStore.self) private var terminal

    var body: some View {
        // React's .claude-feed: top of screen, left-aligned, dark
        // surface + cream text + dim border, multi-line wrapping.
        VStack(alignment: .leading, spacing: 3) {
            ForEach(terminal.open ? [] : Array(push.feed.suffix(8).reversed())) { line in
                Text(line.text)
                    .font(Font.app(12))
                    .tracking(1)
                    .foregroundStyle(Color(hex: "#ebdbb2"))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(hex: "#151515").opacity(0.95))
                    .overlay(Rectangle().stroke(Color(hex: "#a89984"), lineWidth: 1))
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 60)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .allowsHitTesting(false)
        .animation(.easeOut(duration: 0.2), value: push.feed.count)
    }
}
