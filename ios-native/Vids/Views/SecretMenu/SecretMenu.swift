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
        // iOS 26 Liquid Glass spacing — measured against stock Settings
        // on iPhone 17 Pro. Card insets 20pt from screen edges, 24pt
        // gap between cards, 26pt corner radius.
        ScrollView {
            GlassEffectContainer(spacing: 14) {
                VStack(spacing: 14) {
                    glassCard(volumeSection)
                    glassCard(findMySection)
                    glassCard(syncOffsetSection)
                    glassCard(macSection)
                    glassCard(audioOutputSection)
                    glassCard(bluetoothSection)
                    glassCard(fontSection)
                    glassCard(brightnessSection)
                }
                .padding(.horizontal, 20)
                // Clearance for the sheet's drag indicator handle —
                // without this the first card sits right under it.
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

    // MARK: glass card wrapper (iOS 26 Liquid Glass)

    @ViewBuilder
    private func glassCard<Content: View>(_ content: Content) -> some View {
        content
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            // Black-tinted glass instead of white — pale-but-not-white
            // surface that fades into the dim sheet bg.
            .glassEffect(.regular.tint(.black.opacity(0.10)),
                         in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5)
            )
            .shadow(color: .black.opacity(0.4), radius: 18, y: 8)
    }

    /// Section with a stronger header (subheadline.bold), rows separated
    /// by hairlines for the iOS Settings-style structure.
    @ViewBuilder
    private func cardSection<Content: View>(_ header: String? = nil,
                                            @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let header {
                Text(header)
                    // Softer header: footnote.semibold secondary instead
                    // of subheadline.bold primary — reads as a label,
                    // not a billboard, which is what was making the
                    // sections feel harsh.
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 12)
            }
            _VariadicView.Tree(SeparatedRows()) {
                content()
            }
        }
    }

    /// Rows separated by faint gradient hairlines that fade at the
    /// margins instead of edge-to-edge solid dividers.
    private struct SeparatedRows: _VariadicView_MultiViewRoot {
        @ViewBuilder
        func body(children: _VariadicView.Children) -> some View {
            let last = children.last?.id
            ForEach(children) { child in
                child
                    .padding(.vertical, 12)
                if child.id != last {
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.04),
                            Color.white.opacity(0.18),
                            Color.white.opacity(0.04),
                        ],
                        startPoint: .leading, endPoint: .trailing
                    )
                    .frame(height: 1)
                }
            }
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
        cardSection("Volume") {
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
        cardSection("Find My — Maria") {
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
            actionRow("Refresh location", icon: "arrow.clockwise") {
                Task {
                    try? await services.api.refreshFindMy()
                    await refreshFriend(force: true)
                }
            }
        }
    }

    // MARK: sync offset

    private var syncOffsetSection: some View {
        cardSection("Live sync offset") {
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
        cardSection("Mac") {
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
        cardSection("Audio output") {
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
        cardSection("Bluetooth") {
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
        cardSection("Font") {
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
        cardSection("Brightness") {
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
