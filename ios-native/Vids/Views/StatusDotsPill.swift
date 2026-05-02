import SwiftUI

/// Top-right floating glass pill. Tap → the SAME glass surface morphs
/// into a bigger panel showing labeled dots + a FindMy location
/// screenshot. Implemented as a single view with conditional inner
/// content + `.frame()`/shape changes so iOS 26's Liquid Glass
/// interpolates the shape smoothly (mount/unmount two separate views
/// blocked the morph; needed one persistent glass surface that just
/// resizes).
struct StatusDotsPill: View {
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @Environment(ThemeStore.self) private var theme

    @State private var findmyDistance: String = ""
    @State private var findmyTimeFragment: String = ""
    @State private var findmyCrossStreet: String = ""
    @State private var findmyCropUrl: String = ""
    @State private var findmyCropImage: UIImage? = nil
    private var expanded: Bool {
        get { services.ui.statusPillExpanded }
    }
    @MainActor
    private func setExpanded(_ v: Bool) {
        services.ui.statusPillExpanded = v
    }

    private var pillTint: Color {
        if let r = theme.resolved {
            return r.darken(0.55).opacity(0.7)
        }
        return Color(red: 40/255, green: 40/255, blue: 40/255).opacity(0.7)
    }

    /// Animated shape — RoundedRectangle with a large radius reads as a
    /// capsule when the view is short, and as a regular rounded panel
    /// when it grows. Single shape primitive lets `.glassEffect(in:)`
    /// interpolate cleanly instead of swapping Capsule ↔ Rect.
    private var shape: some InsettableShape {
        RoundedRectangle(cornerRadius: 26, style: .continuous)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            content
                .padding(.horizontal, expanded ? 18 : 14)
                .padding(.vertical, expanded ? 18 : 10)
                .frame(maxWidth: expanded ? 320 : nil, alignment: expanded ? .leading : .center)
                .frame(minWidth: expanded ? 320 : 0, alignment: .leading)
                .contentShape(shape)
                .glassEffect(.regular.tint(pillTint), in: shape)
                .clipShape(shape)
                .onTapGesture {
                    Haptics.tap()
                    setExpanded(!expanded)
                }
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0.5).onEnded { _ in
                        Haptics.success()
                        services.ui.secretMenuOpen = true
                    }
                )
        }
        // SwiftUI animates frame, padding, and the glassEffect's
        // shape together as one transition since they're all on the
        // same view. Spring matches Liquid Glass's lift-out feel.
        .animation(.spring(response: 0.42, dampingFraction: 0.84), value: expanded)
        .task { await pollFindmy() }
    }

    @ViewBuilder
    private var content: some View {
        if expanded {
            expandedContent
        } else {
            collapsedContent
        }
    }

    private var collapsedContent: some View {
        HStack(spacing: 6) {
            HStack(spacing: 4) {
                StatusDot(on: true)
                StatusDot(on: playback.macStatus.ethernet ?? false)
                StatusDot(on: !(playback.macStatus.locked ?? false))
                StatusDot(on: !(playback.macStatus.screenOff ?? false))
            }
            if !findmyDistance.isEmpty || !findmyTimeFragment.isEmpty {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.appText.opacity(0.65))
                if !findmyDistance.isEmpty {
                    Text(findmyDistance)
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color.appText.opacity(0.85))
                }
                if !findmyTimeFragment.isEmpty {
                    Text(findmyTimeFragment)
                        .font(.system(size: 10, weight: .regular, design: .monospaced))
                        .foregroundStyle(Color.appText.opacity(0.55))
                        .lineLimit(1)
                }
            }
        }
        .transition(.scale(scale: 0.9).combined(with: .opacity))
    }

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                LegendRow(label: "WS", on: true)
                LegendRow(label: "Ethernet", on: playback.macStatus.ethernet ?? false)
                LegendRow(label: "Mac unlocked", on: !(playback.macStatus.locked ?? false))
                LegendRow(label: "Screen on", on: !(playback.macStatus.screenOff ?? false))
            }
            if !findmyDistance.isEmpty || !findmyCrossStreet.isEmpty || findmyCropImage != nil {
                Divider().background(Color.appText.opacity(0.12))
                if let img = findmyCropImage {
                    Image(uiImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(maxWidth: .infinity)
                        .frame(height: 200)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .strokeBorder(Color.white.opacity(0.15), lineWidth: 0.5)
                        )
                }
                VStack(alignment: .leading, spacing: 2) {
                    if !findmyCrossStreet.isEmpty {
                        Text(findmyCrossStreet)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Color.appText)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    HStack(spacing: 6) {
                        if !findmyDistance.isEmpty {
                            Text(findmyDistance)
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                .foregroundStyle(Color.appText.opacity(0.85))
                        }
                        if !findmyTimeFragment.isEmpty {
                            Text("·")
                                .font(.system(size: 11))
                                .foregroundStyle(Color.appText.opacity(0.4))
                            Text(findmyTimeFragment)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Color.appText.opacity(0.55))
                        }
                    }
                }
            }
        }
        .transition(.scale(scale: 0.95, anchor: .topTrailing).combined(with: .opacity))
    }

    /// Poll FindMy every 30s. When server-reported `ageMs` exceeds
    /// 3min, kick /api/refresh-findmy to activate the FindMy macOS
    /// app, wait for iCloud to push fresh location, re-park + re-OCR.
    private func pollFindmy() async {
        let staleThresholdMs: Double = 3 * 60 * 1000
        while !Task.isCancelled {
            if let status = try? await services.api.findmyStatus(), status.running == true {
                if let f = try? await services.api.findmyFriend() {
                    await applyFriend(f)
                    if (f.ageMs ?? 0) > staleThresholdMs {
                        try? await services.api.refreshFindMy()
                        if let g = try? await services.api.findmyFriend() {
                            await applyFriend(g)
                        }
                    }
                }
            } else {
                await MainActor.run {
                    findmyDistance = ""
                    findmyTimeFragment = ""
                    findmyCrossStreet = ""
                    findmyCropUrl = ""
                    findmyCropImage = nil
                }
            }
            try? await Task.sleep(nanoseconds: 30_000_000_000)
        }
    }

    @MainActor
    private func applyFriend(_ f: ApiClient.FindMyFriend) async {
        findmyDistance = f.distance ?? ""
        findmyTimeFragment = f.timeFragment ?? ""
        findmyCrossStreet = f.crossStreet ?? ""
        let newCrop = f.cropUrl ?? ""
        if newCrop != findmyCropUrl {
            findmyCropUrl = newCrop
            if !newCrop.isEmpty,
               let url = URL(string: "http://\(services.serverHost)\(newCrop)") {
                if let (data, _) = try? await URLSession.shared.data(from: url),
                   let img = UIImage(data: data) {
                    findmyCropImage = img
                }
            }
        }
    }
}

private struct LegendRow: View {
    let label: String
    let on: Bool
    var body: some View {
        HStack(spacing: 10) {
            StatusDot(on: on)
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.appText.opacity(on ? 0.9 : 0.4))
        }
    }
}

private struct StatusDot: View {
    let on: Bool
    @State private var pulse: Bool = false
    var body: some View {
        Circle()
            .fill(on ? Color(hex: "#8ec07c") : Color(hex: "#3c3836"))
            .frame(width: 5, height: 5)
            .scaleEffect(pulse ? 1.6 : 1)
            .opacity(pulse ? 0.4 : 1)
            .animation(.easeOut(duration: 0.45), value: pulse)
            .onChange(of: on) { _, _ in
                pulse = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { pulse = false }
            }
    }
}
