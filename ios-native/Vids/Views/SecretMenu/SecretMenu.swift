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
    @State private var refreshingFriend: Bool = false

    var body: some View {
        // iOS 26 Liquid Glass spacing — measured against stock Settings
        // on iPhone 17 Pro. Card insets 20pt from screen edges, 24pt
        // gap between cards, 26pt corner radius.
        ScrollView {
            // GlassEffectContainer merges adjacent glass cards into
            // one continuous Liquid Glass surface — drops the
            // individual borders so the sections read as one body.
            GlassEffectContainer(spacing: 14) {
                VStack(spacing: 14) {
                    volumeSection.glassCard()
                    findMySection.glassCard()
                    syncOffsetSection.glassCard()
                    macSection.glassCard()
                    audioOutputSection.glassCard()
                    bluetoothSection.glassCard()
                    fontSection.glassCard()
                    brightnessSection.glassCard()
                }
                .padding(.horizontal, 20)
                .padding(.top, 28)
                .padding(.bottom, 28)
            }
        }
        .scrollContentBackground(.hidden)
        // Drop the system blue accent — propagates to Toggle, Slider,
        // Button, Picker checkmarks, etc.
        .tint(Color(hex: "#8ec07c"))
        .task {
            await loadOutputs()
            await loadVolume()
            await loadSyncOffset()
            await loadStealth()
            await refreshFriend(force: false)
        }
    }

    // glass card chrome moved to Views/Common/GlassCard.swift —
    // shared by AudioOutputSheet so the two sheets stay identical.

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
        CardSection("Volume") {
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
        CardSection("Find My — Maria") {
            HStack(alignment: .top) {
                Image(systemName: "location.fill")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    if let f = friend, let cs = f.crossStreet {
                        Text(cs)
                        HStack(spacing: 6) {
                            if let a = f.address { Text(a) }
                            if let d = f.distance { Text("• \(d)") }
                        }
                        .font(.caption).foregroundStyle(.secondary)
                        if let t = f.timeFragment {
                            Text(t).font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    } else if let f = friend, f.ok == false {
                        Text(f.reason ?? "no data").foregroundStyle(.secondary)
                        if let h = f.hint {
                            Text(h).font(.caption).foregroundStyle(.secondary)
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
            actionRow(refreshingFriend ? "Refreshing…" : "Refresh location",
                      icon: "arrow.clockwise") {
                guard !refreshingFriend else { return }
                refreshingFriend = true
                Task {
                    await ui.toast("Refreshing FindMy…")
                    try? await services.api.refreshFindMy()
                    await refreshFriend(force: true)
                    refreshingFriend = false
                    await ui.toast("FindMy updated")
                }
            }
        }
    }

    // MARK: sync offset

    private var syncOffsetSection: some View {
        CardSection("Live sync offset") {
            // Single composed child → no divider between the readout
            // and the slider (they're one control, not two rows).
            VStack(alignment: .leading, spacing: 6) {
                HStack {
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
        CardSection("Mac") {
            Toggle("Keep awake", isOn: Binding(
                get: { playback.macStatus.keepAwake ?? false },
                set: { v in
                    // Optimistic local update so the Toggle commits
                    // immediately — server's macStatus broadcast lags
                    // by up to 10s and the binding would otherwise
                    // snap back to the stale `false`.
                    playback.macStatus.keepAwake = v
                    Task { try? await services.api.keepAwake(v) }
                }
            ))
            actionRow("Lock Mac", icon: "lock") {
                Task { try? await services.api.lockMac(); await ui.toast("Mac locked") }
            }
            actionRow("Refresh cookies", icon: "key") {
                Task { try? await services.api.refreshCookies(); await ui.toast("Cookies refreshed") }
            }
            actionRow("Toggle resolution", icon: "rectangle.portrait.split.2x1") {
                Task { try? await services.api.toggleResolution(); await ui.toast("Resolution toggled") }
            }
            actionRow("AirPlay", icon: "airplayvideo") {
                services.avHost.showAirPlayPicker()
            }
            actionRow("Toggle FindMy app", icon: "location.viewfinder") {
                Task { try? await services.api.toggleFindMy() }
            }
        }
    }

    private func actionRow(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .frame(width: 20)
                    .foregroundStyle(.secondary)
                Text(title).foregroundStyle(.primary)
                Spacer()
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: audio output

    private var audioOutputSection: some View {
        CardSection("Audio output") {
            if outputs.isEmpty {
                Text("loading…").foregroundStyle(.secondary)
            } else {
                ForEach(outputs) { o in
                    selectRow(label: o.name, selected: o.active) {
                        Task { try? await services.api.setAudioOutput(o.name); await loadOutputs() }
                    }
                }
            }
        }
    }

    /// Tappable row with a checkmark when selected — used for output /
    /// font / quality lists where Picker(.inline) doesn't look right
    /// inside a glass card.
    private func selectRow(label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(label).foregroundStyle(.primary)
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color(hex: "#8ec07c"))
                        .font(.body.weight(.semibold))
                }
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: bluetooth

    private var bluetoothSection: some View {
        CardSection("Bluetooth") {
            ForEach(btDevices) { d in
                selectRow(label: d.name ?? d.address, selected: d.connected == true) {
                    Task {
                        if d.connected == true { try? await services.api.bluetoothDisconnect(d.address) }
                        else { try? await services.api.bluetoothConnect(d.address) }
                        btDevices = (try? await services.api.bluetoothDevices()) ?? []
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
        CardSection("Font") {
            ForEach(FontStore.entries, id: \.label) { entry in
                selectRow(label: entry.label, selected: services.fonts.label == entry.label) {
                    services.fonts.setLabel(entry.label)
                }
            }
            HStack(spacing: 6) {
                Text("Size").foregroundStyle(.secondary).font(.caption)
                Spacer(minLength: 0)
                Picker("Size", selection: Binding(
                    get: { services.fonts.size },
                    set: { services.fonts.setSize($0) }
                )) {
                    ForEach(FontStore.sizes, id: \.self) { px in
                        Text("\(Int(px))").tag(px)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 220)
            }
            .padding(.top, 4)
        }
    }

    // MARK: brightness

    private var brightnessSection: some View {
        CardSection("Brightness") {
            HStack {
                Image(systemName: "sun.min").foregroundStyle(.secondary)
                Slider(value: Binding(
                    get: { brightness },
                    set: { v in brightness = v; Task { try? await services.api.setBrightness(v) } }
                ), in: 0...1)
                Image(systemName: "sun.max").foregroundStyle(.secondary)
            }
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
