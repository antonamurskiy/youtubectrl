import SwiftUI

/// Right-aligned stack of individual buttons + a question box, matching
/// the React .claude-quick-reply (App.jsx:684, App.css:1698). Each option
/// is its own button (not a row in a shared panel) — text is "N text",
/// magenta border, translucent dark-navy bg, pink-cream text.
struct ClaudeQuickReply: View {
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @Environment(TerminalStore.self) private var terminal
    @State private var pressed: Int? = nil

    // React palette
    private let magenta = Color(hex: "#b16286")
    private let buttonBg = Color(red: 26/255, green: 26/255, blue: 46/255).opacity(0.7)
    private let pinkText = Color(hex: "#f0c0e0")
    private let bgFlat = Color(hex: "#282828")

    var body: some View {
        let visible = !playback.claudeOptions.isEmpty &&
            (playback.claudeState == "waiting" || playback.claudeState == "thinking")
        if visible {
            VStack(alignment: .trailing, spacing: 4) {
                if let q = playback.claudeQuestion, !q.isEmpty {
                    Text(q)
                        .font(Font.app(13))
                        .foregroundStyle(pinkText)
                        .multilineTextAlignment(.trailing)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .frame(maxWidth: 220, alignment: .trailing)
                        .background(bgFlat)
                        .overlay(Rectangle().stroke(magenta, lineWidth: 1))
                }
                ForEach(playback.claudeOptions, id: \.n) { opt in
                    Button(action: { tap(opt) }) {
                        Text("\(opt.n) \(opt.text)")
                            .font(Font.app(13))
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 320, alignment: .trailing)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 16)
                            .frame(minHeight: 56)
                            .foregroundStyle(pressed == opt.n ? bgFlat : pinkText)
                            .background(pressed == opt.n ? magenta : buttonBg)
                            .overlay(Rectangle().stroke(magenta.opacity(0.6), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            .padding(.trailing, 16)
            // bottom: calc(var(--np-height, 220px) + 106px) ≈ 326 when playing
            // body.keyboard-open: bottom: 498px
            .padding(.bottom, terminal.keyboardOpen
                ? terminal.keyboardHeight + 162
                : (playback.playing ? 326 : 122))
            .ignoresSafeArea(.keyboard, edges: .bottom)
            .allowsHitTesting(true)
            .transition(.opacity)
        }
    }

    private func tap(_ opt: ClaudeOption) {
        pressed = opt.n
        Task {
            try? await services.api.tmuxSend(String(opt.n))
            try? await Task.sleep(nanoseconds: 200_000_000)
            await MainActor.run { pressed = nil }
        }
    }
}
