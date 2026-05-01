import SwiftUI

struct ToastHUD: View {
    @Environment(UIStore.self) private var ui
    @Environment(TerminalStore.self) private var terminal

    var body: some View {
        VStack(spacing: 8) {
            ForEach(terminal.open ? [] : ui.toasts) { t in
                Text(t.text)
                    .font(.system(size: 13, weight: .semibold))
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
                    .font(.system(size: 28, weight: .bold, design: .monospaced))
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

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            ForEach(push.feed.suffix(6).reversed(), id: \.self) { line in
                Text(line)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.6))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.black.opacity(0.55))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
        .padding(.top, 100)
        .padding(.trailing, 12)
        .allowsHitTesting(false)
    }
}
