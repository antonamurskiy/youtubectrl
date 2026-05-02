import SwiftUI

/// iOS Control Center-style audio menu — fat volume slider with the
/// active output icon, then a list of selectable outputs (Mac speakers,
/// HomePod, AirPlay) and a Bluetooth section beneath.
struct AudioOutputSheet: View {
    @Environment(ServiceContainer.self) private var services
    @Environment(PlaybackStore.self) private var playback
    @Environment(UIStore.self) private var ui
    @State private var outputs: [ApiClient.AudioOutput] = []
    @State private var btDevices: [ApiClient.BluetoothDevice] = []
    @State private var volume: Double = 0.5
    @State private var muted: Bool = false

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                glassCard {
                    cardSection(nil) {
                        volumeRow
                    }
                }
                glassCard {
                    cardSection("Output") {
                        if outputs.isEmpty {
                            Text("loading…").foregroundStyle(.secondary)
                        } else {
                            ForEach(outputs) { o in
                                outputRow(name: o.name,
                                          active: o.active,
                                          color: Color(hex: "#8ec07c")) {
                                    Task {
                                        try? await services.api.setAudioOutput(o.name)
                                        await loadOutputs()
                                    }
                                }
                            }
                        }
                    }
                }
                glassCard {
                    cardSection("Bluetooth") {
                        if btDevices.isEmpty {
                            Text("no devices").foregroundStyle(.secondary)
                        } else {
                            ForEach(btDevices) { d in
                                outputRow(name: d.name ?? d.address,
                                          active: d.connected == true,
                                          color: Color(hex: "#6c99bb")) {
                                    Task {
                                        if d.connected == true { try? await services.api.bluetoothDisconnect(d.address) }
                                        else { try? await services.api.bluetoothConnect(d.address) }
                                        btDevices = (try? await services.api.bluetoothDevices()) ?? []
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 28)
            .padding(.bottom, 28)
        }
        .scrollContentBackground(.hidden)
        .tint(Color(hex: "#8ec07c"))
        .task {
            await loadOutputs()
            await loadVolume()
            btDevices = (try? await services.api.bluetoothDevices()) ?? []
        }
    }

    // MARK: card chrome (matches SecretMenu)

    @ViewBuilder
    private func glassCard<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular.tint(.black.opacity(0.10)),
                         in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5)
            )
            .shadow(color: .black.opacity(0.4), radius: 18, y: 8)
    }

    @ViewBuilder
    private func cardSection<Content: View>(_ header: String? = nil,
                                            @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let header {
                Text(header)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 12)
            }
            _VariadicView.Tree(SeparatedRows()) { content() }
        }
    }

    private struct SeparatedRows: _VariadicView_MultiViewRoot {
        @ViewBuilder
        func body(children: _VariadicView.Children) -> some View {
            let last = children.last?.id
            ForEach(children) { child in
                child.padding(.vertical, 12)
                if child.id != last {
                    Rectangle()
                        .fill(Color.white.opacity(0.10))
                        .frame(height: 0.5)
                }
            }
        }
    }

    // MARK: rows

    private var volumeRow: some View {
        HStack(spacing: 14) {
            Button {
                muted.toggle()
                Task { try? await services.api.setVolume(muted ? 0 : volume) }
            } label: {
                Image(systemName: muted || volume == 0 ? "speaker.slash.fill" : volumeSymbol)
                    .font(.title3.weight(.semibold))
                    .frame(width: 28, height: 28)
                    .foregroundStyle(Color.appText.opacity(0.9))
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(.plain)
            Slider(value: Binding(
                get: { muted ? 0 : volume },
                set: { v in
                    volume = v
                    muted = v == 0
                    Task { try? await services.api.setVolume(v) }
                }
            ), in: 0...1)
        }
    }

    private var volumeSymbol: String {
        if volume < 0.34 { return "speaker.wave.1.fill" }
        if volume < 0.67 { return "speaker.wave.2.fill" }
        return "speaker.wave.3.fill"
    }

    private func outputRow(name: String, active: Bool, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: outputSymbol(name))
                    .frame(width: 22)
                    .foregroundStyle(active ? color : .secondary)
                Text(name)
                    .foregroundStyle(active ? color : .primary)
                Spacer()
                if active {
                    Image(systemName: "checkmark")
                        .foregroundStyle(color)
                        .font(.body.weight(.semibold))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func outputSymbol(_ name: String) -> String {
        let n = name.lowercased()
        if n.contains("airpods max") { return "airpodsmax" }
        if n.contains("airpods pro") { return "airpodspro" }
        if n.contains("airpods")     { return "airpods" }
        if n.contains("homepod")     { return "homepod.fill" }
        if n.contains("beats")       { return "beats.headphones" }
        if n.contains("headphone")   { return "headphones" }
        if n.contains("airplay")     { return "airplayaudio" }
        if n.contains("display") || n.contains("lg ") || n.contains("monitor") { return "tv" }
        if n.contains("macbook") || n.contains("built")    { return "laptopcomputer" }
        return "speaker.wave.2.fill"
    }

    // MARK: loaders

    @MainActor
    private func loadOutputs() async {
        outputs = (try? await services.api.audioOutputs()) ?? []
    }
    @MainActor
    private func loadVolume() async {
        if let v = try? await services.api.volumeStatus() {
            volume = v.volume ?? 0.5
            muted = v.muted ?? false
        }
    }
}
