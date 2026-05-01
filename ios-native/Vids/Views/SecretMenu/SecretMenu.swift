import SwiftUI

struct SecretMenu: View {
    @Environment(UIStore.self) private var ui
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services

    @State private var miscOpen: Bool = false
    @State private var btOpen: Bool = false
    @State private var outputs: [ApiClient.AudioOutput] = []
    @State private var btDevices: [ApiClient.BluetoothDevice] = []
    @State private var brightness: Double = 0.5
    @State private var brightnessLoaded: Bool = false
    @State private var volume: Double = 0.5
    @State private var muted: Bool = false
    @State private var syncOffsetMs: Double = 0
    @State private var stealth: Bool = false
    @State private var friend: ApiClient.FindMyFriend? = nil

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            ScrollView {
                VStack(spacing: 0) {
                    handle
                    statusRow
                    Divider().background(Color.appText.opacity(0.1))
                    volumeRow
                    Divider().background(Color.appText.opacity(0.1))
                    findMyBlock
                    Divider().background(Color.appText.opacity(0.1))
                    syncOffsetRow
                    Divider().background(Color.appText.opacity(0.1))
                    keepAwakeRow
                    Divider().background(Color.appText.opacity(0.1))
                    outputsSection
                    Divider().background(Color.appText.opacity(0.1))
                    btSection
                    Divider().background(Color.appText.opacity(0.1))
                    miscToggle
                    if miscOpen { miscSection }
                    close
                }
            }
            .frame(maxHeight: 640)
            .background(Color(hex: "#151515"))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .padding(8)
        }
        .background(Color.black.opacity(0.45).ignoresSafeArea())
        .onTapGesture { ui.secretMenuOpen = false }
        .task {
            await loadOutputs()
            await loadVolume()
            await loadSyncOffset()
            await loadStealth()
            await refreshFriend(force: false)
        }
    }

    // MARK: rows

    private var handle: some View {
        Capsule().fill(Color.appText.opacity(0.15)).frame(width: 36, height: 4).padding(.top, 8).padding(.bottom, 6)
    }

    private var statusRow: some View {
        HStack(spacing: 8) {
            statusBadge("WS", on: true)
            statusBadge("ETH", on: playback.macStatus.ethernet ?? false)
            statusBadge("UNLK", on: !(playback.macStatus.locked ?? false))
            statusBadge("SCR", on: !(playback.macStatus.screenOff ?? false))
            statusBadge("AWK", on: playback.macStatus.keepAwake ?? false)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func statusBadge(_ label: String, on: Bool) -> some View {
        Text(label)
            .font(Font.app(11, weight: .bold, design: .monospaced))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(on ? Color(hex: "#8ec07c").opacity(0.18) : Color(hex: "#3c3836").opacity(0.4))
            .foregroundStyle(on ? Color(hex: "#8ec07c") : Color(hex: "#a89984"))
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private var volumeRow: some View {
        HStack(spacing: 10) {
            Button(action: {
                muted.toggle()
                Task { try? await services.api.setVolume(muted ? 0 : volume) }
            }) {
                Image(systemName: muted || volume == 0 ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    .frame(width: 28)
            }
            .buttonStyle(.plain)
            Slider(value: Binding(
                get: { volume },
                set: { v in
                    volume = v
                    muted = v == 0
                    Task { try? await services.api.setVolume(v) }
                }
            ), in: 0...1)
        }
        .foregroundStyle(Color.appText.opacity(0.85))
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var syncOffsetRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Live sync offset").font(Font.app(12, weight: .semibold))
                Spacer()
                Text("\(Int(syncOffsetMs)) ms")
                    .font(Font.app(11, design: .monospaced))
                    .foregroundStyle(Color.appText.opacity(0.55))
            }
            Slider(value: Binding(
                get: { syncOffsetMs },
                set: { v in
                    syncOffsetMs = v
                    Task { try? await services.api.setSyncOffset(v) }
                }
            ), in: -8000...8000, step: 100)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .foregroundStyle(Color.appText.opacity(0.85))
    }

    private var keepAwakeRow: some View {
        Button(action: {
            let next = !(playback.macStatus.keepAwake ?? false)
            Task { try? await services.api.keepAwake(next) }
        }) {
            HStack {
                Image(systemName: "cup.and.saucer")
                Text("Keep awake").font(Font.app(13))
                Spacer()
                Text(playback.macStatus.keepAwake == true ? "ON" : "OFF")
                    .font(Font.app(10, weight: .bold, design: .monospaced))
                    .foregroundStyle(playback.macStatus.keepAwake == true ? Color(hex: "#8ec07c") : Color.appText.opacity(0.4))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .foregroundStyle(Color.appText.opacity(0.85))
        }
        .buttonStyle(.plain)
    }

    private var outputsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Audio output").font(Font.app(13, weight: .semibold))
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .foregroundStyle(Color.appText.opacity(0.85))

            if outputs.isEmpty {
                Text("loading…").font(Font.app(11, design: .monospaced))
                    .foregroundStyle(Color.appText.opacity(0.4))
                    .padding(.horizontal, 24).padding(.vertical, 8)
            } else {
                ForEach(outputs) { o in
                    Button(action: {
                        Task { try? await services.api.setAudioOutput(o.name); await loadOutputs() }
                    }) {
                        HStack {
                            Text(o.name).font(Font.app(13))
                                .foregroundStyle(o.active ? Color(hex: "#8ec07c") : Color.appText.opacity(0.85))
                            Spacer()
                            if o.active { Image(systemName: "checkmark") }
                        }
                        .padding(.horizontal, 24).padding(.vertical, 9)
                        .background(o.active ? Color(hex: "#8ec07c").opacity(0.18) : Color(hex: "#0a0a0a"))
                        .overlay(alignment: .leading) {
                            if o.active { Rectangle().fill(Color(hex: "#8ec07c")).frame(width: 3) }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.bottom, 4)
    }

    private var btSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: {
                btOpen.toggle()
                if btOpen { Task { btDevices = (try? await services.api.bluetoothDevices()) ?? [] } }
            }) {
                HStack {
                    Image(systemName: "homepod.and.appletv")
                    Text("Bluetooth").font(Font.app(13, weight: .semibold))
                    Spacer()
                    Image(systemName: btOpen ? "chevron.up" : "chevron.down")
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .foregroundStyle(Color.appText.opacity(0.85))
            }
            .buttonStyle(.plain)

            if btOpen {
                if btDevices.isEmpty {
                    Text("no devices").font(Font.app(11, design: .monospaced))
                        .foregroundStyle(Color.appText.opacity(0.4))
                        .padding(.horizontal, 24).padding(.vertical, 8)
                }
                ForEach(btDevices) { d in
                    Button(action: {
                        Task {
                            if d.connected == true { try? await services.api.bluetoothDisconnect(d.address) }
                            else { try? await services.api.bluetoothConnect(d.address) }
                            btDevices = (try? await services.api.bluetoothDevices()) ?? []
                        }
                    }) {
                        HStack {
                            Text(d.name ?? d.address).font(Font.app(13))
                                .foregroundStyle(d.connected == true ? Color(hex: "#6c99bb") : Color.appText.opacity(0.85))
                            Spacer()
                            if d.connected == true { Image(systemName: "checkmark") }
                        }
                        .padding(.horizontal, 24).padding(.vertical, 9)
                        .background(d.connected == true ? Color(hex: "#6c99bb").opacity(0.18) : Color(hex: "#0a0a0a"))
                        .overlay(alignment: .leading) {
                            if d.connected == true { Rectangle().fill(Color(hex: "#6c99bb")).frame(width: 3) }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.bottom, 4)
    }

    private var miscToggle: some View {
        Button(action: { withAnimation { miscOpen.toggle() } }) {
            HStack {
                Text("Misc").font(Font.app(13, weight: .semibold))
                Spacer()
                Image(systemName: miscOpen ? "chevron.up" : "chevron.down")
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .foregroundStyle(Color.appText.opacity(0.85))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var miscSection: some View {
        VStack(spacing: 0) {
            fontPickerRow
            fontSizeRow
            HStack {
                Image(systemName: "sun.max")
                Text("Brightness").font(Font.app(13))
                Spacer()
                Slider(value: Binding(
                    get: { brightness },
                    set: { v in brightness = v; Task { try? await services.api.setBrightness(v) } }
                ), in: 0...1)
                .frame(width: 140)
            }
            .padding(.horizontal, 24).padding(.vertical, 10)
            .foregroundStyle(Color.appText.opacity(0.85))
            .background(Color(hex: "#0a0a0a"))
            .task {
                // Poll while menu open so slider reflects Mac-side
                // changes (brightness keys on the Mac, etc.).
                while !Task.isCancelled {
                    if let b = try? await services.api.brightness() { brightness = b }
                    brightnessLoaded = true
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }

            row(icon: "rectangle.portrait.split.2x1", title: "Toggle resolution") {
                Task { try? await services.api.toggleResolution(); await ui.toast("Resolution toggled") }
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
            row(icon: "location.viewfinder", title: "Toggle FindMy app") {
                Task { try? await services.api.toggleFindMy() }
            }
        }
    }

    // MARK: FindMy

    private var findMyBlock: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "location.fill")
                VStack(alignment: .leading, spacing: 2) {
                    Text("Maria").font(Font.app(13))
                    if let f = friend, let cross = f.cross, let parallel = f.parallel {
                        Text("\(parallel) & \(cross)")
                            .font(Font.app(10, design: .monospaced))
                            .foregroundStyle(Color.appText.opacity(0.55))
                        if let t = f.timeFragment {
                            Text(t).font(Font.app(9, design: .monospaced))
                                .foregroundStyle(Color.appText.opacity(0.4))
                        }
                    } else {
                        Text("tap refresh").font(Font.app(10, design: .monospaced))
                            .foregroundStyle(Color.appText.opacity(0.4))
                    }
                }
                Spacer()
                // Stealth toggle
                Button(action: {
                    Task {
                        let next = !stealth
                        try? await services.api.setFindmyStealth(next)
                        stealth = next
                        await ui.toast(next ? "Find My stealth on" : "Find My visible")
                    }
                }) {
                    Image(systemName: stealth ? "eye.slash" : "eye")
                        .foregroundStyle(stealth ? Color.appText.opacity(0.5) : Color(hex: "#8ec07c"))
                }
                .buttonStyle(.plain)
                // Force refresh
                Button(action: {
                    Task {
                        try? await services.api.refreshFindMy()
                        await refreshFriend(force: true)
                    }
                }) {
                    Image(systemName: "arrow.clockwise")
                        .foregroundStyle(Color.appText.opacity(0.7))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .foregroundStyle(Color.appText.opacity(0.85))
        }
    }

    // MARK: footer

    private var close: some View {
        Button(action: { ui.secretMenuOpen = false }) {
            Text("Close")
                .font(Font.app(13, weight: .semibold))
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .background(Color.appText.opacity(0.05))
                .foregroundStyle(Color.appText)
        }
        .buttonStyle(.plain)
    }

    private func row(icon: String, title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Image(systemName: icon)
                Text(title).font(Font.app(13))
                Spacer()
            }
            .foregroundStyle(Color.appText.opacity(0.85))
            .padding(.horizontal, 24).padding(.vertical, 10)
            .background(Color(hex: "#0a0a0a"))
        }
        .buttonStyle(.plain)
    }

    // MARK: loaders

    @State private var fontsOpen: Bool = false

    private var fontPickerRow: some View {
        VStack(spacing: 0) {
            Button(action: { fontsOpen.toggle() }) {
                HStack {
                    Image(systemName: "textformat")
                    Text("Font").font(Font.app(13))
                    Spacer()
                    Text(services.fonts.label)
                        .font(Font.app(11, design: .monospaced))
                        .foregroundStyle(Color.appText.opacity(0.55))
                    Image(systemName: fontsOpen ? "chevron.up" : "chevron.down")
                }
                .foregroundStyle(Color.appText.opacity(0.85))
                .padding(.horizontal, 24).padding(.vertical, 10)
                .background(Color(hex: "#0a0a0a"))
            }
            .buttonStyle(.plain)
            if fontsOpen {
                ForEach(FontStore.entries, id: \.label) { entry in
                    Button(action: { services.fonts.setLabel(entry.label) }) {
                        HStack {
                            Text(entry.label)
                                .font(Font.app(12))
                                .foregroundStyle(services.fonts.label == entry.label ? Color(hex: "#8ec07c") : Color.appText.opacity(0.75))
                            Spacer()
                            if services.fonts.label == entry.label { Image(systemName: "checkmark") }
                        }
                        .padding(.horizontal, 36).padding(.vertical, 8)
                        .background(Color(hex: "#0a0a0a"))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var fontSizeRow: some View {
        HStack {
            Image(systemName: "textformat.size")
            Text("Font size").font(Font.app(13))
            Spacer()
            ForEach(FontStore.sizes, id: \.self) { px in
                Button(action: { services.fonts.setSize(px) }) {
                    Text("\(Int(px))")
                        .font(Font.app(11, design: .monospaced))
                        .frame(width: 22, height: 22)
                        .background(services.fonts.size == px ? Color(hex: "#8ec07c").opacity(0.25) : Color.clear)
                        .foregroundStyle(services.fonts.size == px ? .white : Color.appText.opacity(0.55))
                        .clipShape(RoundedRectangle(cornerRadius: 3))
                }
                .buttonStyle(.plain)
            }
        }
        .foregroundStyle(Color.appText.opacity(0.85))
        .padding(.horizontal, 24).padding(.vertical, 10)
        .background(Color(hex: "#0a0a0a"))
    }

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
