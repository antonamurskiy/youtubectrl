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
    @State private var dismissTask: Task<Void, Never>? = nil
    /// Snapshot of the prompt at the moment we presented it. Reading
    /// `playback.claudeOptions` directly inside `confirmationDialog`
    /// produced an empty dialog whenever the server cleared the prompt
    /// during the 6s grace window: the dialog is still up, the live
    /// values went empty, ForEach renders nothing.
    @State private var shownQuestion: String = ""
    @State private var shownOptions: [ClaudeOption] = []

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
                shownQuestion.isEmpty ? "Choose" : shownQuestion,
                isPresented: $presented,
                titleVisibility: .visible
            ) {
                ForEach(shownOptions, id: \.n) { opt in
                    Button(opt.text) {
                        Haptics.success()
                        Task { try? await services.api.tmuxSend(String(opt.n)) }
                    }
                }
                Button("Cancel", role: .cancel) { }
            } message: {
                if !shownQuestion.isEmpty {
                    Text(shownQuestion)
                }
            }
            .onChange(of: playback.claudeState) { _, _ in syncPresent() }
            .onChange(of: promptKey) { _, _ in syncPresent() }
    }

    /// Drive presentation state from the server's claude state. New prompt
    /// (key change) auto-shows. Transition out of "waiting" doesn't dismiss
    /// immediately — Claude often flips to "idle" within ~200ms of the
    /// prompt appearing, before the user can read + tap. Hold the dialog
    /// open for 6s after the waiting state ends so taps still land.
    private func syncPresent() {
        let waiting = playback.claudeState == "waiting" && !playback.claudeOptions.isEmpty
        if waiting && promptKey != lastShownKey {
            dismissTask?.cancel()
            dismissTask = nil
            lastShownKey = promptKey
            // Snapshot before flipping `presented` — the dialog reads
            // `shownQuestion` / `shownOptions` and they have to be
            // populated by the time SwiftUI starts presenting.
            shownQuestion = playback.claudeQuestion ?? ""
            shownOptions = playback.claudeOptions
            presented = true
        } else if !waiting && presented {
            // Server says no longer waiting. Schedule a delayed dismiss
            // so a fast-flipping Claude state doesn't yank the dialog
            // out from under a tap. shownQuestion/shownOptions stay
            // pinned so the dialog content doesn't go blank.
            dismissTask?.cancel()
            dismissTask = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                guard !Task.isCancelled else { return }
                presented = false
            }
        }
    }
}
