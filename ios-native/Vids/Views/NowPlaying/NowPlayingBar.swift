import SwiftUI

struct NowPlayingBar: View {
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @Environment(ThemeStore.self) private var theme
    @Environment(PhoneModeStore.self) private var phoneMode
    @State private var speedPressed: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            ScrubberView()
                .frame(height: 28)

            // Sub-row: -10, time, eye, LIVE/GO LIVE, audio, PiP, duration, +10
            HStack(spacing: 8) {
                skipBtn("-10") { Task { try? await services.api.skip(-10) } }
                Text(positionLabel)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.65))
                    .frame(minWidth: 36, alignment: .leading)
                Button(action: { Task { try? await services.api.toggleVisibility() } }) {
                    Image(systemName: playback.visible ? "eye" : "eye.slash")
                        .foregroundStyle(playback.visible ? Color(hex: "#8ec07c") : Color(hex: "#d05050"))
                        .font(.system(size: 14))
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
                Text(liveLabel)
                    .font(.system(size: 11, weight: .heavy, design: .monospaced))
                    .foregroundStyle(liveLabelColor)
                    .onTapGesture {
                        guard playback.isLive && !playback.isPostLive else { return }
                        Task { try? await services.api.goLive() }
                    }
                Spacer(minLength: 0)
                speedButton
                pipButton
                Text(durationLabel)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.65))
                    .frame(minWidth: 36, alignment: .trailing)
                skipBtn("+10") { Task { try? await services.api.skip(10) } }
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)

            // Button row: monitor laptop / LG, maximize, fullscreen, mode, stop
            HStack(spacing: 8) {
                npBtn(active: playback.monitor == "laptop", systemName: "laptopcomputer") {
                    Task { try? await services.api.moveMonitor("laptop") }
                }
                npBtn(active: playback.monitor == "lg", systemName: "display") {
                    Task { try? await services.api.moveMonitor("lg") }
                }
                npBtn(active: playback.windowMode == "maximize", systemName: "arrow.up.left.and.arrow.down.right.square") {
                    Task { try? await services.api.toggleMaximize() }
                }
                npBtn(active: playback.windowMode == "fullscreen", systemName: "rectangle.inset.filled") {
                    Task { try? await services.api.toggleFullscreen() }
                }
                npBtn(active: phoneMode.mode != .computer, systemName: phoneMode.mode == .sync ? "iphone.gen3" : (phoneMode.mode == .phoneOnly ? "iphone.badge.play" : "macbook")) {
                    Task { await phoneMode.toggle(services: services) }
                }
                Spacer()
                npBtn(active: false, systemName: "stop.fill") {
                    Task { try? await services.api.stop() }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)

            // Title + transport
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(playback.title)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(1)
                        .foregroundStyle(.white)
                    Text(playback.channel)
                        .font(.system(size: 12))
                        .lineLimit(1)
                        .foregroundStyle(.white.opacity(0.55))
                }
                Spacer()
                HStack(spacing: 18) {
                    Button(action: { Task { try? await services.api.skip(-15) } }) {
                        Image(systemName: "gobackward.15")
                    }
                    Button(action: { Task { try? await services.api.playPause() } }) {
                        Image(systemName: playback.paused ? "play.fill" : "pause.fill")
                            .font(.system(size: 22))
                    }
                    Button(action: { Task { try? await services.api.skip(15) } }) {
                        Image(systemName: "goforward.15")
                    }
                }
                .foregroundStyle(.white)
                .font(.system(size: 18, weight: .medium))
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity)
        .background(theme.resolvedSurface)
    }

    // MARK: helpers

    private func skipBtn(_ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 11, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.65))
                .padding(.horizontal, 4)
        }
        .buttonStyle(.plain)
    }

    private func npBtn(active: Bool, systemName: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 14, weight: .medium))
                .frame(width: 36, height: 32)
                .foregroundStyle(active ? Color(hex: "#8ec07c") : .white.opacity(0.65))
                .background(active ? Color(hex: "#8ec07c").opacity(0.15) : .clear)
                .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(.plain)
    }

    private var speedButton: some View {
        Text(speedLabel)
            .font(.system(size: 11, weight: .heavy, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .foregroundStyle(speedTextColor)
            .background(speedPressed ? Color.white.opacity(0.15) : .clear)
            .clipShape(RoundedRectangle(cornerRadius: 3))
            .gesture(
                LongPressGesture(minimumDuration: 0.15)
                    .onChanged { _ in
                        if !speedPressed {
                            speedPressed = true
                            Task { try? await services.api.mpvSpeed(2.0) }
                        }
                    }
                    .onEnded { _ in
                        speedPressed = false
                        Task { try? await services.api.mpvSpeed(1.0) }
                    }
            )
    }

    private var pipButton: some View {
        let active = services.avHost.pipActive
        return Button(action: {
            if active { services.avHost.stopPip() } else { services.avHost.startPip() }
        }) {
            Image(systemName: active ? "pip.exit" : "pip.enter")
                .font(.system(size: 14))
                .foregroundStyle(active ? Color(hex: "#8ec07c") : .white.opacity(0.6))
        }
        .buttonStyle(.plain)
    }

    // MARK: derived labels

    private var speedLabel: String {
        if speedPressed { return "2×" }
        let s = playback.speed
        if abs(s - 1.0) < 0.01 { return "1×" }
        return String(format: "%.2f×", s)
    }

    private var speedTextColor: Color {
        if speedPressed { return .white }
        if abs(playback.speed - 1.0) < 0.01 { return .white.opacity(0.55) }
        return Color(hex: "#cc4040")
    }

    private var positionLabel: String {
        if playback.isLive && !playback.isPostLive {
            let behind = max(0, playback.duration - playback.position)
            return behind < 5 ? "LIVE" : "-\(formatTime(behind))"
        }
        return formatTime(playback.position)
    }

    private var durationLabel: String {
        if playback.isLive && !playback.isPostLive { return "" }
        return formatTime(playback.duration)
    }

    private var liveLabel: String {
        guard playback.isLive && !playback.isPostLive else { return "" }
        let behind = max(0, playback.duration - playback.position)
        return behind < 5 ? "LIVE" : "GO LIVE"
    }

    private var liveLabelColor: Color {
        guard playback.isLive && !playback.isPostLive else { return .white.opacity(0.5) }
        let behind = max(0, playback.duration - playback.position)
        return behind < 5 ? Color(hex: "#cc4040") : Color(hex: "#a89984")
    }

    private func formatTime(_ s: Double) -> String {
        let total = Int(s.rounded())
        let h = total / 3600, m = (total % 3600) / 60, sec = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }
}
