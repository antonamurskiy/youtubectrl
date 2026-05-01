import SwiftUI

struct AudioOutputSheet: View {
    @Environment(ServiceContainer.self) private var services
    @Environment(UIStore.self) private var ui
    @State private var outputs: [ApiClient.AudioOutput] = []
    @State private var btDevices: [ApiClient.BluetoothDevice] = []
    @State private var btShown: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "speaker.wave.2.fill")
                Text("Audio output").font(Font.app(14, weight: .semibold))
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 8)
            .foregroundStyle(Color.appText)

            Divider().background(Color.appText.opacity(0.1))

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(outputs) { o in
                        Button(action: {
                            Task { try? await services.api.setAudioOutput(o.name); await load() }
                        }) {
                            HStack {
                                Text(o.name).font(Font.app(13))
                                    .foregroundStyle(o.active ? Color(hex: "#8ec07c") : Color.appText.opacity(0.85))
                                Spacer()
                                if o.active { Image(systemName: "checkmark") }
                            }
                            .padding(.horizontal, 16).padding(.vertical, 10)
                            .background(o.active ? Color(hex: "#8ec07c").opacity(0.18) : Color(hex: "#0a0a0a"))
                            .overlay(alignment: .leading) {
                                if o.active { Rectangle().fill(Color(hex: "#8ec07c")).frame(width: 3) }
                            }
                        }
                        .buttonStyle(.plain)
                    }

                    // Bluetooth subsection
                    Button(action: {
                        btShown.toggle()
                        if btShown { Task { btDevices = (try? await services.api.bluetoothDevices()) ?? [] } }
                    }) {
                        HStack {
                            Image(systemName: "homepod.and.appletv")
                            Text("Bluetooth").font(Font.app(13, weight: .semibold))
                            Spacer()
                            Image(systemName: btShown ? "chevron.up" : "chevron.down")
                        }
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .foregroundStyle(Color.appText.opacity(0.85))
                    }
                    .buttonStyle(.plain)

                    if btShown {
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
            }
        }
        .task { await load() }
    }

    @MainActor
    private func load() async {
        outputs = (try? await services.api.audioOutputs()) ?? []
    }
}
