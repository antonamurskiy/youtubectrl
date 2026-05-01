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

    static let palette: [String] = [
        "#a13a36", "#cc7a3f", "#cca35c", "#8b9b4a",
        "#4f8a5c", "#3a7a8a", "#3a5a8a", "#7a3a8a",
    ]

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Text("Rename window")
                    .font(Font.app(13, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
                Spacer()
            }
            TextField("name", text: $name)
                .textFieldStyle(.plain)
                .padding(8)
                .background(.white.opacity(0.06))
                .foregroundStyle(.white)
                .submitLabel(.done)
                .onSubmit(commit)
            HStack(spacing: 8) {
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
                        .background(.white.opacity(0.06)).foregroundStyle(.white)
                }
                .buttonStyle(.plain)
                Button(action: commit) {
                    Text("ok").frame(maxWidth: .infinity).padding(.vertical, 10)
                        .background(Color(hex: "#8ec07c").opacity(0.25)).foregroundStyle(.white)
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
