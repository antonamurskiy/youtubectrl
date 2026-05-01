import SwiftUI

struct NowPlayingBar: View {
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @Environment(ThemeStore.self) private var theme
    @Environment(PhoneModeStore.self) private var phoneMode
    @Environment(UIStore.self) private var ui
    @State private var speedPressed: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            ScrubberView()
                .frame(height: 28)
                .padding(.top, 14)

            hairline.padding(.top, 8)

            // Sub-row: -10, time, eye, LIVE/GO LIVE, audio, PiP, duration, +10
            HStack(spacing: 8) {
                skipBtn("-10") { Task { try? await services.api.skip(-10) } }
                Text(positionLabel)
                    .font(Font.app(11, design: .monospaced))
                    .foregroundStyle(Color.appText.opacity(0.65))
                    .frame(minWidth: 36, alignment: .leading)
                Button(action: { Task { try? await services.api.toggleVisibility() } }) {
                    Image(systemName: playback.visible ? "eye" : "eye.slash")
                        .contentTransition(.symbolEffect(.replace))
                        .foregroundStyle(playback.visible ? Color(hex: "#8ec07c") : Color(hex: "#d05050"))
                        .font(Font.app(14))
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
                Text(liveLabel)
                    .font(Font.app(11, weight: .heavy, design: .monospaced))
                    .foregroundStyle(liveLabelColor)
                    .onTapGesture {
                        guard playback.isLive && !playback.isPostLive else { return }
                        Task { try? await services.api.goLive() }
                    }
                Spacer(minLength: 0)
                speedButton
                audioButton
                pipButton
                Text(durationLabel)
                    .font(Font.app(11, design: .monospaced))
                    .foregroundStyle(Color.appText.opacity(0.65))
                    .frame(minWidth: 36, alignment: .trailing)
                skipBtn("+10") { Task { try? await services.api.skip(10) } }
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 8)

            hairline

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
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 10)

            hairline

            // Title + transport
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(playback.title)
                        .font(Font.app(14, weight: .semibold))
                        .lineLimit(1)
                        .foregroundStyle(Color.appText)
                    Text(playback.channel)
                        .font(Font.app(12))
                        .lineLimit(1)
                        .foregroundStyle(Color.appText.opacity(0.55))
                }
                .onLongPressGesture { ui.qualityMenuOpen = true }
                Spacer()
                Button(action: { ui.commentsOpen.toggle() }) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(Font.app(14))
                        .foregroundStyle(ui.commentsOpen ? Color(hex: "#8ec07c") : Color.appText.opacity(0.6))
                }
                .buttonStyle(.plain)
                HStack(spacing: 18) {
                    Button(action: { Haptics.tap(); Task { try? await services.api.skip(-15) } }) {
                        Image(systemName: "gobackward.15")
                    }
                    Button(action: { Haptics.toggle(); Task { try? await services.api.playPause() } }) {
                        Image(systemName: playback.paused ? "play.fill" : "pause.fill")
                            .contentTransition(.symbolEffect(.replace))
                            .font(Font.app(22))
                    }
                    Button(action: { Haptics.tap(); Task { try? await services.api.skip(15) } }) {
                        Image(systemName: "goforward.15")
                    }
                }
                .foregroundStyle(Color.appText)
                .font(Font.app(18, weight: .medium))
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 14)
        }
        .frame(maxWidth: .infinity)
        // Absorb touches across the whole bar — without this, taps in
        // the empty regions between buttons fall through to the video
        // cells underneath.
        .contentShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        // iOS 26 Liquid Glass mini-player: floating glass surface with
        // a top hairline. Sheet-style instead of the flat dark bar.
        // Glass painted as a BACKGROUND layer (not via .glassEffect on
        // self) so the scrubber preview tile can render OUTSIDE the
        // bar's rounded-rect shape. .glassEffect(in: shape) applies
        // the shape as a clip mask to descendants too, which was
        // hiding the storyboard preview that floats above the bar.
        // Match FAB stack: direct .glassEffect with the same tint
        // computation. No extra strokeBorder rim — Liquid Glass
        // already paints its own directional highlight, and any
        // additional stroke fights the system rim.
        .glassEffect(
            .regular.tint(barTint).interactive(),
            in: RoundedRectangle(cornerRadius: 28, style: .continuous)
        )
        // Publish the bar's frame in screen-global coords so the
        // ScrubPreviewOverlay (rendered as a SIBLING of this bar, not
        // a descendant) can place its floating tile above us.
        .background(GeometryReader { geo in
            Color.clear.preference(key: NPBarFrameKey.self,
                                   value: geo.frame(in: .named("root")))
        })
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
    }

    /// Glass tint mirrors the FAB stack: tmux pane color when the
    /// terminal is open, per-tab color otherwise, dark fallback.
    private var barTint: Color {
        if let r = theme.resolved {
            return r.darken(0.55).opacity(0.7)
        }
        return Color(red: 40/255, green: 40/255, blue: 40/255).opacity(0.7)
    }

    /// Faint divider that gives the rows visual structure on the
    /// translucent glass surface — same hairline pattern as the
    /// secret menu cards.
    private var hairline: some View {
        Rectangle()
            .fill(Color.white.opacity(0.08))
            .frame(height: 0.5)
    }

    // MARK: helpers

    private func skipBtn(_ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: { Haptics.tap(); action() }) {
            Text(label)
                .font(Font.app(11, weight: .heavy, design: .monospaced))
                .foregroundStyle(Color.appText.opacity(0.65))
                .padding(.horizontal, 8)
                .padding(.vertical, 8)
                // Explicit hit-test region — without this, the bar's
                // outer .contentShape(RoundedRectangle) captured taps
                // before the tiny text caught them.
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func npBtn(active: Bool, systemName: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(Font.app(14, weight: .medium))
                .frame(width: 36, height: 32)
                .foregroundStyle(active ? Color(hex: "#8ec07c") : Color.appText.opacity(0.65))
                .background(active ? Color(hex: "#8ec07c").opacity(0.15) : .clear)
                .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(.plain)
    }

    private var speedButton: some View {
        Text(speedLabel)
            .font(Font.app(11, weight: .heavy, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .foregroundStyle(speedTextColor)
            .background(speedPressed ? Color.appText.opacity(0.15) : .clear)
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

    private var audioButton: some View {
        Button(action: { ui.audioSheetOpen = true }) {
            Image(systemName: "speaker.wave.2.fill")
                .font(Font.app(14))
                .foregroundStyle(Color.appText.opacity(0.65))
        }
        .buttonStyle(.plain)
    }

    private var pipButton: some View {
        let active = services.avHost.pipActive
        return Button(action: {
            if active { services.avHost.stopPip() } else { services.avHost.startPip() }
        }) {
            Image(systemName: active ? "pip.exit" : "pip.enter")
                .contentTransition(.symbolEffect(.replace))
                .font(Font.app(14))
                .foregroundStyle(active ? Color(hex: "#8ec07c") : Color.appText.opacity(0.6))
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
        if speedPressed { return Color.appText }
        if abs(playback.speed - 1.0) < 0.01 { return Color.appText.opacity(0.55) }
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
        guard playback.isLive && !playback.isPostLive else { return Color.appText.opacity(0.5) }
        let behind = max(0, playback.duration - playback.position)
        return behind < 5 ? Color(hex: "#cc4040") : Color(hex: "#a89984")
    }

    private func formatTime(_ s: Double) -> String {
        let total = Int(s.rounded())
        let h = total / 3600, m = (total % 3600) / 60, sec = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }
}
