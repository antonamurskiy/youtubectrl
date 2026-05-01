import SwiftUI

/// Floats above the FAB stack when Claude is waiting on a multi-choice
/// question. Tap a numbered button to send the digit straight to the
/// active tmux window via /api/tmux-send + /api/tmux-select. Mirrors
/// the React app's .claude-quick-reply (App.jsx:684).
struct ClaudeQuickReply: View {
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @State private var pressed: Int? = nil

    var body: some View {
        // Show on waiting OR thinking with options so the user always
        // sees the latest prompt — the React app does the same.
        let visible = !playback.claudeOptions.isEmpty &&
            (playback.claudeState == "waiting" || playback.claudeState == "thinking")
        if visible {
            VStack(alignment: .leading, spacing: 6) {
                if let q = playback.claudeQuestion, !q.isEmpty {
                    Text(q)
                        .font(Font.app(12))
                        .foregroundStyle(Color.appText.opacity(0.7))
                        .lineLimit(3)
                }
                ForEach(playback.claudeOptions, id: \.n) { opt in
                    Button(action: { tap(opt.n) }) {
                        HStack(spacing: 8) {
                            Text("\(opt.n)")
                                .font(Font.app(13, weight: .heavy))
                                .frame(width: 22, height: 22)
                                .foregroundStyle(Color.appText)
                                .background(Color(hex: "#b16286").opacity(0.3))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                            Text(opt.text)
                                .font(Font.app(13))
                                .foregroundStyle(Color.appText.opacity(0.9))
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            Spacer()
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .background((pressed == opt.n ? Color(hex: "#b16286").opacity(0.35) : Color.clear))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(10)
            .frame(maxWidth: 320, alignment: .leading)
            .background(Color(hex: "#151515").opacity(0.96))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(Color(hex: "#b16286"), lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .padding(.horizontal, 12)
            .padding(.bottom, playback.playing ? 280 : 80)
            .allowsHitTesting(true)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private func tap(_ n: Int) {
        pressed = n
        Task {
            try? await services.api.tmuxSend(String(n))
            try? await Task.sleep(nanoseconds: 200_000_000)
            await MainActor.run { pressed = nil }
        }
    }
}
