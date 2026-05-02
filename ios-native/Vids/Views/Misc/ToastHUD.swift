import SwiftUI

struct ToastHUD: View {
    @Environment(UIStore.self) private var ui
    @Environment(TerminalStore.self) private var terminal

    var body: some View {
        VStack(spacing: 8) {
            ForEach(terminal.open ? [] : ui.toasts) { t in
                Text(t.text)
                    .font(Font.app(13, weight: .semibold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .foregroundStyle(Color.appText)
                    // iOS 26 glass capsule like AirDrop banners.
                    .glassEffect(.regular.tint(.white.opacity(0.10)), in: Capsule())
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
                    .foregroundStyle(Color.appText)
                Rectangle()
                    .fill(Color.appText.opacity(0.15))
                    .frame(width: 160, height: 4)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(Color.appText)
                            .frame(width: 160 * CGFloat(max(0, min(100, pulse.percent))) / 100, height: 4)
                    }
                    .clipShape(Capsule())
            }
            .padding(24)
            // iOS 26 system-volume-HUD-style glass card.
            .glassEffect(.regular.tint(.white.opacity(0.10)),
                         in: RoundedRectangle(cornerRadius: 22, style: .continuous))
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
        VStack(alignment: .leading, spacing: 6) {
            ForEach(terminal.open ? [] : Array(push.feed.suffix(8).reversed())) { line in
                FeedLineView(line: line, lifetime: push.lifetime, tintHex: tintHex(for: line.text))
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 60)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .allowsHitTesting(false)
        .animation(.easeOut(duration: 0.25), value: push.feed.count)
    }

    /// Server prefixes feed lines with "[winname] " when the window has a name.
    /// Look up the matching tmux color so the feed line border + text follow
    /// the originating window's tint.
    private func tintHex(for text: String) -> String? {
        guard text.hasPrefix("["),
              let close = text.firstIndex(of: "]") else { return nil }
        let name = String(text[text.index(after: text.startIndex)..<close])
        return terminal.resolveColor(name)
    }
}

private struct FeedLineView: View {
    let line: FeedLine
    let lifetime: TimeInterval
    let tintHex: String?
    @State private var visible: Bool = false
    @State private var fading: Bool = false

    private var pillTint: Color {
        // Tmux window color (when prefixed) drives the glass tint —
        // matches the FAB/NPBar/pill convention.
        if let h = tintHex { return Color(hex: h).opacity(0.55) }
        return Color(red: 40/255, green: 40/255, blue: 40/255).opacity(0.7)
    }
    private var textColor: Color {
        if let h = tintHex { return Color(hex: h).lighten(0.45) }
        return Color(hex: "#ebdbb2")
    }

    var body: some View {
        Text(line.text)
            .font(Font.app(12))
            .foregroundStyle(textColor)
            .lineLimit(1)
            .truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            // RoundedRectangle (12pt corner) instead of Capsule —
            // the full pill shape was reading too rounded for short
            // notification lines and let text hug too close to the
            // curve. Subtle rounded rect matches iOS 26 banner style.
            .glassEffect(.regular.tint(pillTint).interactive(),
                         in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .opacity(visible && !fading ? 1 : 0)
            .onAppear {
                withAnimation(.easeOut(duration: 0.2)) { visible = true }
                let fadeStart = max(0, lifetime - 1.5)
                DispatchQueue.main.asyncAfter(deadline: .now() + fadeStart) {
                    withAnimation(.easeIn(duration: 0.6)) { fading = true }
                }
            }
            .transition(.opacity)
    }
}
