import SwiftUI

/// Native iOS action sheet that auto-presents when the server pushes a
/// Claude waiting-prompt. Same pattern as the video long-press menu —
/// system-rendered, follows iOS's accent + dark mode, dismissable by
/// tapping outside. Replaces the floating magenta panel.
struct ClaudeQuickReply: View {
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @State private var lastShownKey: String = ""
    @State private var presented: Bool = false

    private var promptKey: String {
        let opts = playback.claudeOptions.map { "\($0.n):\($0.text)" }.joined(separator: "|")
        return "\(playback.claudeQuestion ?? "")||\(opts)"
    }

    var body: some View {
        // Anchor the confirmationDialog on a 1pt frame — a 0×0 host
        // is sometimes pruned from the layout tree on iOS 26, which
        // makes the dialog never present.
        Color.clear
            .frame(width: 1, height: 1)
            .confirmationDialog(
                playback.claudeQuestion ?? "Choose",
                isPresented: $presented,
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
            .onChange(of: playback.claudeState) { _, _ in syncPresent() }
            .onChange(of: promptKey) { _, _ in syncPresent() }
    }

    /// Drive presentation state from the server's claude state. New prompt
    /// (key change) auto-shows; transition out of "waiting" auto-hides.
    private func syncPresent() {
        let waiting = playback.claudeState == "waiting" && !playback.claudeOptions.isEmpty
        if waiting && promptKey != lastShownKey {
            lastShownKey = promptKey
            presented = true
        } else if !waiting {
            presented = false
        }
    }
}
