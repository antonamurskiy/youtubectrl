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
    @State private var btShown: Bool = true
    @State private var volume: Double = 0.5
    @State private var muted: Bool = false

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                volumeCard
                outputsCard
                bluetoothCard
            }
            .padding(.horizontal, 16)
            // 28pt top clears the sheet's drag indicator handle —
            // matches the secret menu spacing.
            .padding(.top, 28)
            .padding(.bottom, 24)
        }
        .scrollContentBackground(.hidden)
        .tint(Color(hex: "#8ec07c"))
        .task {
            await loadOutputs()
            await loadVolume()
            // Bluetooth section is open by default; pre-load devices.
            btDevices = (try? await services.api.bluetoothDevices()) ?? []
        }
    }

    // MARK: volume

    private var volumeCard: some View {
        HStack(spacing: 14) {
            Button {
                muted.toggle()
                Task { try? await services.api.setVolume(muted ? 0 : volume) }
            } label: {
                Image(systemName: muted || volume == 0 ? "speaker.slash.fill" : volumeSymbol)
                    .font(.title3.weight(.semibold))
                    .frame(width: 32, height: 32)
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
        .padding(.vertical, 18)
        .padding(.horizontal, 18)
        .glassEffect(.regular.tint(.black.opacity(0.10)),
                     in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private var volumeSymbol: String {
        if volume < 0.34 { return "speaker.wave.1.fill" }
        if volume < 0.67 { return "speaker.wave.2.fill" }
        return "speaker.wave.3.fill"
    }

    // MARK: outputs

    private var outputsCard: some View {
        VStack(spacing: 0) {
            sectionHeader("Output", icon: outputSymbol(playback.audioOutput))
            if outputs.isEmpty {
                Text("loading…")
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(Array(outputs.enumerated()), id: \.1.id) { idx, o in
                    if idx > 0 { hairline }
                    outputRow(name: o.name, active: o.active, color: Color(hex: "#8ec07c")) {
                        Task {
                            try? await services.api.setAudioOutput(o.name)
                            await loadOutputs()
                        }
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 14)
        .glassEffect(.regular.tint(.black.opacity(0.10)),
                     in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    // MARK: bluetooth

    private var bluetoothCard: some View {
        VStack(spacing: 0) {
            Button {
                btShown.toggle()
                if btShown && btDevices.isEmpty {
                    Task { btDevices = (try? await services.api.bluetoothDevices()) ?? [] }
                }
            } label: {
                HStack {
                    Image(systemName: "homepod.and.appletv")
                        .foregroundStyle(.secondary)
                    Text("Bluetooth")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    Spacer()
                    Image(systemName: btShown ? "chevron.up" : "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 12)
            }
            .buttonStyle(.plain)
            if btShown {
                ForEach(Array(btDevices.enumerated()), id: \.1.id) { idx, d in
                    if idx == 0 { hairline }
                    if idx > 0 { hairline }
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
        .padding(.horizontal, 14)
        .glassEffect(.regular.tint(.black.opacity(0.10)),
                     in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    // MARK: row helpers

    private func sectionHeader(_ title: String, icon: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(.secondary)
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Spacer()
        }
        .padding(.vertical, 10)
    }

    private func outputRow(name: String, active: Bool, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
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
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var hairline: some View {
        LinearGradient(colors: [
            Color.white.opacity(0.04),
            Color.white.opacity(0.16),
            Color.white.opacity(0.04),
        ], startPoint: .leading, endPoint: .trailing)
        .frame(height: 0.5)
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
