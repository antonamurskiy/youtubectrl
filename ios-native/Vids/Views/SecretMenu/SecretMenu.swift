import SwiftUI

struct SecretMenu: View {
    @Environment(UIStore.self) private var ui
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @State private var miscOpen: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 0) {
                handle
                statusRow
                Divider().background(.white.opacity(0.1))
                outputsSection
                Divider().background(.white.opacity(0.1))
                miscToggle
                if miscOpen { miscSection }
                close
            }
            .background(Color(hex: "#151515"))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .padding(8)
        }
        .background(Color.black.opacity(0.45).ignoresSafeArea())
        .onTapGesture { ui.secretMenuOpen = false }
    }

    private var handle: some View {
        Capsule().fill(.white.opacity(0.15)).frame(width: 36, height: 4).padding(.top, 8).padding(.bottom, 6)
    }

    private var statusRow: some View {
        HStack(spacing: 8) {
            statusBadge("WS", on: true)
            statusBadge("ETH", on: playback.macStatus.ethernet ?? false)
            statusBadge("UNLK", on: !(playback.macStatus.locked ?? false))
            statusBadge("SCR", on: !(playback.macStatus.screenOff ?? false))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func statusBadge(_ label: String, on: Bool) -> some View {
        Text(label)
            .font(.system(size: 11, weight: .bold, design: .monospaced))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(on ? Color(hex: "#8ec07c").opacity(0.18) : Color(hex: "#3c3836").opacity(0.4))
            .foregroundStyle(on ? Color(hex: "#8ec07c") : Color(hex: "#a89984"))
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private var outputsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            row(icon: "speaker.wave.2", title: "Outputs", action: nil, sub: false)
            // Phase 9b: live device list. For now, single "Speakers" placeholder.
            row(icon: "•", title: "Speakers", action: {}, sub: true)
        }
        .padding(.vertical, 6)
    }

    private var miscToggle: some View {
        Button(action: { withAnimation { miscOpen.toggle() } }) {
            HStack {
                Text("Misc")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Image(systemName: miscOpen ? "chevron.up" : "chevron.down")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .foregroundStyle(.white.opacity(0.85))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var miscSection: some View {
        VStack(spacing: 0) {
            row(icon: "sun.max", title: "Brightness slider", action: {}, sub: true)
            row(icon: "rectangle.portrait", title: "Toggle resolution", action: {}, sub: true)
            row(icon: "key", title: "Refresh cookies", action: {}, sub: true)
            row(icon: "lock", title: "Lock Mac", action: {}, sub: true)
            row(icon: "airplayvideo", title: "AirPlay", action: {}, sub: true)
        }
    }

    private var close: some View {
        Button(action: { ui.secretMenuOpen = false }) {
            Text("Close")
                .font(.system(size: 13, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(.white.opacity(0.05))
                .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
    }

    private func row(icon: String, title: String, action: (() -> Void)?, sub: Bool) -> some View {
        Button(action: { action?() }) {
            HStack {
                Text(icon).font(.system(size: 13))
                Text(title).font(.system(size: 13))
                Spacer()
            }
            .foregroundStyle(.white.opacity(0.85))
            .padding(.horizontal, sub ? 24 : 12)
            .padding(.vertical, 10)
            .background(sub ? Color(hex: "#0a0a0a") : .clear)
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }
}
