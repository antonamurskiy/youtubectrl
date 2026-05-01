import SwiftUI

/// Long-press on a tmux tab → centered modal with rename + 8 color
/// swatches. Live preview via TerminalStore.colorPreview while editing,
/// committed via /api/tmux-color + /api/tmux-rename on OK.
struct TmuxRenamePopover: View {
    @Environment(TerminalStore.self) private var terminal
    @Environment(ServiceContainer.self) private var services
    let window: TmuxWindow
    @Binding var open: Bool

    @State private var name: String = ""
    @State private var color: String = ""

    /// React App.jsx TMUX_COLOR_SWATCHES merged with the original
    /// native picks. Two rows: dim + saturated.
    static let palette: [String] = [
        // Dim
        "#5a1f1c", "#3a1414", "#5a2828", "#5e3414", "#4a2810", "#3d2a1c",
        "#5c4416", "#4a4416", "#3f4416", "#2c3812", "#1f3d24", "#2e4a3a",
        "#1c4548", "#1f3d49", "#1c2c4a", "#2c2e4a", "#3a2647", "#4a2e44",
        "#4a2438", "#4a2030", "#2a2a2a", "#3a342e", "#2e3438",
        // Saturated (gruvbox medium-ish)
        "#a13a36", "#b85e22", "#c58a25", "#7a8a30", "#4f8a5c", "#3f8a8c",
        "#3f7099", "#5a5fa3", "#8a5a96", "#a05680", "#7a5a4a", "#6a6a6a",
        // Original native picks
        "#cc7a3f", "#cca35c", "#8b9b4a", "#3a7a8a", "#3a5a8a", "#7a3a8a",
    ]

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Text("Rename window")
                    .font(Font.app(13, weight: .semibold))
                    .foregroundStyle(Color.appText.opacity(0.85))
                Spacer()
            }
            TextField("name", text: $name)
                .textFieldStyle(.plain)
                .padding(8)
                .background(Color.appText.opacity(0.06))
                .foregroundStyle(Color.appText)
                .submitLabel(.done)
                .onSubmit(commit)
            // Wider palette → flow into a grid. ~7 swatches per row at
            // 28pt swatch + 6pt spacing fits within the 320pt modal.
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(28), spacing: 6), count: 7), spacing: 6) {
                ForEach(Self.palette, id: \.self) { hex in
                    Button(action: {
                        color = hex
                        terminal.colorPreview[window.name] = hex
                    }) {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color(hex: hex))
                            .frame(width: 28, height: 28)
                            .overlay(
                                RoundedRectangle(cornerRadius: 4)
                                    .strokeBorder(.white.opacity(color == hex ? 0.85 : 0.15), lineWidth: 2)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            HStack(spacing: 12) {
                Button(action: cancel) {
                    Text("cancel").frame(maxWidth: .infinity).padding(.vertical, 10)
                        .background(Color.appText.opacity(0.06)).foregroundStyle(Color.appText)
                }
                .buttonStyle(.plain)
                Button(action: commit) {
                    Text("ok").frame(maxWidth: .infinity).padding(.vertical, 10)
                        .background(Color(hex: "#8ec07c").opacity(0.25)).foregroundStyle(Color.appText)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .frame(maxWidth: 320)
        .background(Color(hex: "#151515"))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .onAppear {
            name = window.name
            color = terminal.colors[window.name] ?? ""
        }
    }

    private func commit() {
        let renamed = !name.isEmpty && name != window.name
        let colorChanged = color != (terminal.colors[window.name] ?? "")
        Task {
            if colorChanged && !color.isEmpty {
                try? await services.api.tmuxColor(name: window.name, color: color)
            }
            if renamed {
                try? await services.api.tmuxRename(index: window.index, name: name)
            }
        }
        terminal.colorPreview.removeValue(forKey: window.name)
        open = false
    }

    private func cancel() {
        terminal.colorPreview.removeValue(forKey: window.name)
        open = false
    }
}
