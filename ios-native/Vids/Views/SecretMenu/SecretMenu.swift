import SwiftUI

struct SecretMenu: View {
    @Environment(UIStore.self) private var ui
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @State private var miscOpen: Bool = false
    @State private var outputs: [ApiClient.AudioOutput] = []
    @State private var brightness: Double = 0.5
    @State private var brightnessLoaded: Bool = false

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
        .task { await loadOutputs() }
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
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Audio output")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .foregroundStyle(.white.opacity(0.85))

            if outputs.isEmpty {
                Text("loading…")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.4))
                    .padding(.horizontal, 24)
                    .padding(.vertical, 10)
            } else {
                ForEach(outputs) { o in
                    Button(action: { Task { try? await services.api.setAudioOutput(o.name); await loadOutputs() } }) {
                        HStack {
                            Text(o.name)
                                .font(.system(size: 13))
                                .foregroundStyle(o.active ? Color(hex: "#8ec07c") : .white.opacity(0.85))
                            Spacer()
                            if o.active { Image(systemName: "checkmark") }
                        }
                        .padding(.horizontal, 24)
                        .padding(.vertical, 10)
                        .background(o.active ? Color(hex: "#8ec07c").opacity(0.18) : Color(hex: "#0a0a0a"))
                        .overlay(alignment: .leading) {
                            if o.active {
                                Rectangle().fill(Color(hex: "#8ec07c")).frame(width: 3)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.bottom, 6)
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
            findMyRow
            HStack {
                Image(systemName: "sun.max")
                Text("Brightness").font(.system(size: 13))
                Spacer()
                Slider(value: Binding(
                    get: { brightness },
                    set: { v in
                        brightness = v
                        Task { try? await services.api.setBrightness(v) }
                    }
                ), in: 0...1)
                .frame(width: 140)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 10)
            .foregroundStyle(.white.opacity(0.85))
            .background(Color(hex: "#0a0a0a"))
            .task {
                if !brightnessLoaded {
                    if let b = try? await services.api.brightness() { brightness = b }
                    brightnessLoaded = true
                }
            }

            row(icon: "key", title: "Refresh cookies") {
                Task { try? await services.api.refreshCookies(); await ui.toast("Cookies refreshed") }
            }
            row(icon: "lock", title: "Lock Mac") {
                Task { try? await services.api.lockMac(); await ui.toast("Mac locked") }
            }
            row(icon: "airplayvideo", title: "AirPlay") {
                services.avHost.showAirPlayPicker()
            }
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

    private func row(icon: String, title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Image(systemName: icon)
                Text(title).font(.system(size: 13))
                Spacer()
            }
            .foregroundStyle(.white.opacity(0.85))
            .padding(.horizontal, 24)
            .padding(.vertical, 10)
            .background(Color(hex: "#0a0a0a"))
        }
        .buttonStyle(.plain)
    }

    @MainActor
    private func loadOutputs() async {
        outputs = (try? await services.api.audioOutputs()) ?? []
    }

    @State private var friend: ApiClient.FindMyFriend? = nil
    @State private var friendLoading: Bool = false

    private var findMyRow: some View {
        HStack {
            Image(systemName: "location.fill")
            VStack(alignment: .leading, spacing: 2) {
                Text("Maria")
                    .font(.system(size: 13))
                if friendLoading {
                    Text("locating…").font(.system(size: 10, design: .monospaced)).foregroundStyle(.white.opacity(0.4))
                } else if let f = friend, let cross = f.cross, let parallel = f.parallel {
                    Text("\(parallel) & \(cross)")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.55))
                    if let t = f.timeFragment {
                        Text(t).font(.system(size: 9, design: .monospaced)).foregroundStyle(.white.opacity(0.4))
                    }
                } else {
                    Text("tap to refresh").font(.system(size: 10, design: .monospaced)).foregroundStyle(.white.opacity(0.4))
                }
            }
            Spacer()
        }
        .foregroundStyle(.white.opacity(0.85))
        .padding(.horizontal, 24)
        .padding(.vertical, 10)
        .background(Color(hex: "#0a0a0a"))
        .onTapGesture {
            Task { await refreshFriend(force: true) }
        }
        .task { await refreshFriend(force: false) }
    }

    @MainActor
    private func refreshFriend(force: Bool) async {
        friendLoading = true
        defer { friendLoading = false }
        friend = try? await services.api.findmyFriend(force: force)
    }
}
