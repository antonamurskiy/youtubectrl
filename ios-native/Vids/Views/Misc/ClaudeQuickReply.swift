import SwiftUI

/// Native iOS action sheet that auto-presents when the server pushes a
/// Claude waiting-prompt. Same pattern as the video long-press menu —
/// system-rendered, follows iOS's accent + dark mode, dismissable by
/// tapping outside. Replaces the floating magenta panel.
struct ClaudeQuickReply: View {
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @State private var dismissedKey: String? = nil

    private var promptKey: String {
        let opts = playback.claudeOptions.map { "\($0.n):\($0.text)" }.joined(separator: "|")
        return "\(playback.claudeQuestion ?? "")||\(opts)"
    }

    private var isPresented: Binding<Bool> {
        Binding(
            get: {
                guard playback.claudeState == "waiting",
                      !playback.claudeOptions.isEmpty,
                      dismissedKey != promptKey else { return false }
                return true
            },
            set: { newValue in
                if !newValue {
                    // Remember this exact prompt was dismissed so we don't
                    // re-present on every WS tick. New prompt = new key.
                    dismissedKey = promptKey
                }
            }
        )
    }

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .confirmationDialog(
                playback.claudeQuestion ?? "Choose",
                isPresented: isPresented,
                titleVisibility: .visible
            ) {
                ForEach(playback.claudeOptions, id: \.n) { opt in
                    Button(opt.text) {
                        Task { try? await services.api.tmuxSend(String(opt.n)) }
                    }
                }
                Button("Cancel", role: .cancel) { }
            } message: {
                if let q = playback.claudeQuestion, !q.isEmpty {
                    Text(q)
                }
            }
    }
}
