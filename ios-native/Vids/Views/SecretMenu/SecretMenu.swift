import SwiftUI

struct SecretMenu: View {
    @Environment(UIStore.self) private var ui
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services

    @State private var outputs: [ApiClient.AudioOutput] = []
    @State private var btDevices: [ApiClient.BluetoothDevice] = []
    @State private var btLoaded: Bool = false
    @State private var brightness: Double = 0.5
    @State private var volume: Double = 0.5
    @State private var muted: Bool = false
    @State private var syncOffsetMs: Double = 0
    @State private var stealth: Bool = false
    @State private var friend: ApiClient.FindMyFriend? = nil

    var body: some View {
        List {
            Group {
                statusSection
                volumeSection
                findMySection
                syncOffsetSection
                macSection
                audioOutputSection
                bluetoothSection
                fontSection
                brightnessSection
            }
            // Per-row glass: each cell paints a thin material backdrop
            // instead of the system grouped-list opaque grey. Section
            // header bg also goes transparent so the sheet material
            // shows through between sections.
            .listRowBackground(
                Rectangle().fill(.ultraThinMaterial)
                    .overlay(Color.white.opacity(0.04))
            )
            .listRowSeparatorTint(Color.white.opacity(0.1))
            .listSectionSeparator(.hidden)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(.clear)
        .task {
            await loadOutputs()
            await loadVolume()
            await loadSyncOffset()
            await loadStealth()
            await refreshFriend(force: false)
        }
    }

    // MARK: status

    private var statusSection: some View {
        Section("Status") {
            statusRow("Ethernet",   on: playback.macStatus.ethernet ?? false)
            statusRow("Mac unlocked", on: !(playback.macStatus.locked ?? false))
            statusRow("Screen on",  on: !(playback.macStatus.screenOff ?? false))
            statusRow("Keep awake", on: playback.macStatus.keepAwake ?? false)
        }
    }

    private func statusRow(_ label: String, on: Bool) -> some View {
        HStack {
            Circle()
                .fill(on ? Color(hex: "#8ec07c") : Color.gray.opacity(0.4))
                .frame(width: 8, height: 8)
            Text(label)
            Spacer()
            Text(on ? "ON" : "OFF")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
        }
    }

    // MARK: volume

    private var volumeSection: some View {
        Section("Volume") {
            HStack {
                Button {
                    muted.toggle()
                    Task { try? await services.api.setVolume(muted ? 0 : volume) }
                } label: {
                    Image(systemName: muted || volume == 0 ? "speaker.slash.fill" : "speaker.wave.2.fill")
                }
                .buttonStyle(.borderless)
                Slider(value: Binding(
                    get: { volume },
                    set: { v in
                        volume = v
                        muted = v == 0
                        Task { try? await services.api.setVolume(v) }
                    }
                ), in: 0...1)
            }
        }
    }

    // MARK: find my

    private var findMySection: some View {
        Section("Find My — Maria") {
            HStack(alignment: .top) {
                Image(systemName: "location.fill")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    if let f = friend, let cross = f.cross, let parallel = f.parallel {
                        Text("\(parallel) & \(cross)")
                        if let t = f.timeFragment {
                            Text(t).font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    } else {
                        Text("tap refresh").foregroundStyle(.secondary)
                    }
                }
            }
            Toggle("Stealth", isOn: Binding(
                get: { stealth },
                set: { newValue in
                    Task {
                        try? await services.api.setFindmyStealth(newValue)
                        stealth = newValue
                        await ui.toast(newValue ? "Find My stealth on" : "Find My visible")
                    }
                }
            ))
            Button {
                Task {
                    try? await services.api.refreshFindMy()
                    await refreshFriend(force: true)
                }
            } label: {
                Label("Refresh location", systemImage: "arrow.clockwise")
            }
        }
    }

    // MARK: sync offset

    private var syncOffsetSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Live sync offset")
                    Spacer()
                    Text("\(Int(syncOffsetMs)) ms")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                Slider(value: Binding(
                    get: { syncOffsetMs },
                    set: { v in
                        syncOffsetMs = v
                        Task { try? await services.api.setSyncOffset(v) }
                    }
                ), in: -8000...8000, step: 100)
            }
        }
    }

    // MARK: mac

    private var macSection: some View {
        Section("Mac") {
            Toggle("Keep awake", isOn: Binding(
                get: { playback.macStatus.keepAwake ?? false },
                set: { v in Task { try? await services.api.keepAwake(v) } }
            ))
            Button {
                Task { try? await services.api.lockMac(); await ui.toast("Mac locked") }
            } label: {
                Label("Lock Mac", systemImage: "lock")
            }
            Button {
                Task { try? await services.api.refreshCookies(); await ui.toast("Cookies refreshed") }
            } label: {
                Label("Refresh cookies", systemImage: "key")
            }
            Button {
                Task { try? await services.api.toggleResolution(); await ui.toast("Resolution toggled") }
            } label: {
                Label("Toggle resolution", systemImage: "rectangle.portrait.split.2x1")
            }
            Button {
                services.avHost.showAirPlayPicker()
            } label: {
                Label("AirPlay", systemImage: "airplayvideo")
            }
            Button {
                Task { try? await services.api.toggleFindMy() }
            } label: {
                Label("Toggle FindMy app", systemImage: "location.viewfinder")
            }
        }
    }

    // MARK: audio output

    private var audioOutputSection: some View {
        Section("Audio output") {
            if outputs.isEmpty {
                Text("loading…").foregroundStyle(.secondary)
            } else {
                Picker("Output", selection: Binding(
                    get: { outputs.first(where: { $0.active })?.name ?? "" },
                    set: { newName in
                        Task { try? await services.api.setAudioOutput(newName); await loadOutputs() }
                    }
                )) {
                    ForEach(outputs) { o in
                        Text(o.name).tag(o.name)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
        }
    }

    // MARK: bluetooth

    private var bluetoothSection: some View {
        Section("Bluetooth") {
            ForEach(btDevices) { d in
                Button {
                    Task {
                        if d.connected == true { try? await services.api.bluetoothDisconnect(d.address) }
                        else { try? await services.api.bluetoothConnect(d.address) }
                        btDevices = (try? await services.api.bluetoothDevices()) ?? []
                    }
                } label: {
                    HStack {
                        Image(systemName: d.connected == true ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(d.connected == true ? Color(hex: "#6c99bb") : .secondary)
                        Text(d.name ?? d.address)
                            .foregroundStyle(.primary)
                        Spacer()
                    }
                }
            }
            if btLoaded && btDevices.isEmpty {
                Text("no devices").foregroundStyle(.secondary)
            }
        }
        .task {
            // Lazy load on first appearance — Bluetooth scan is slow.
            if !btLoaded {
                btDevices = (try? await services.api.bluetoothDevices()) ?? []
                btLoaded = true
            }
        }
    }

    // MARK: font

    private var fontSection: some View {
        Section("Font") {
            Picker("Family", selection: Binding(
                get: { services.fonts.label },
                set: { services.fonts.setLabel($0) }
            )) {
                ForEach(FontStore.entries, id: \.label) { entry in
                    Text(entry.label).tag(entry.label)
                }
            }
            Picker("Size", selection: Binding(
                get: { services.fonts.size },
                set: { services.fonts.setSize($0) }
            )) {
                ForEach(FontStore.sizes, id: \.self) { px in
                    Text("\(Int(px))").tag(px)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    // MARK: brightness

    private var brightnessSection: some View {
        Section {
            HStack {
                Image(systemName: "sun.min").foregroundStyle(.secondary)
                Slider(value: Binding(
                    get: { brightness },
                    set: { v in brightness = v; Task { try? await services.api.setBrightness(v) } }
                ), in: 0...1)
                Image(systemName: "sun.max").foregroundStyle(.secondary)
            }
        } header: {
            Text("Brightness")
        }
        .task {
            // Poll while menu open so slider reflects Mac-side changes.
            while !Task.isCancelled {
                if let b = try? await services.api.brightness() { brightness = b }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    // MARK: loaders

    @MainActor private func loadOutputs() async {
        outputs = (try? await services.api.audioOutputs()) ?? []
    }
    @MainActor private func loadVolume() async {
        if let v = try? await services.api.volumeStatus() {
            volume = v.volume ?? 0.5
            muted = v.muted ?? false
        }
    }
    @MainActor private func loadSyncOffset() async {
        if let v = try? await services.api.syncOffset() { syncOffsetMs = v }
    }
    @MainActor private func loadStealth() async {
        if let v = try? await services.api.findmyStealth() { stealth = v }
    }
    @MainActor private func refreshFriend(force: Bool) async {
        friend = try? await services.api.findmyFriend(force: force)
    }
}
