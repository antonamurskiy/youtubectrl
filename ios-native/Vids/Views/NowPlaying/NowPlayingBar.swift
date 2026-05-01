import SwiftUI

struct NowPlayingBar: View {
    @Environment(PlaybackStore.self) private var playback
    @Environment(ServiceContainer.self) private var services
    @Environment(ThemeStore.self) private var theme
    @Environment(PhoneModeStore.self) private var phoneMode

    var body: some View {
        VStack(spacing: 0) {
            ScrubberView()
                .frame(height: 28)

            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(playback.title)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(1)
                        .foregroundStyle(.white)
                    Text(playback.channel)
                        .font(.system(size: 12))
                        .lineLimit(1)
                        .foregroundStyle(.white.opacity(0.55))
                }
                Spacer()
                HStack(spacing: 16) {
                    Button(action: { Task { await phoneMode.toggle(services: services) } }) {
                        Image(systemName: phoneMode.mode == .sync ? "iphone.gen3" : "macbook")
                            .opacity(phoneMode.loading ? 0.4 : 1)
                    }
                    Button(action: { Task { try? await services.api.skip(-15) } }) {
                        Image(systemName: "gobackward.15")
                    }
                    Button(action: { Task { try? await services.api.playPause() } }) {
                        Image(systemName: playback.paused ? "play.fill" : "pause.fill")
                            .font(.system(size: 22))
                    }
                    Button(action: { Task { try? await services.api.skip(15) } }) {
                        Image(systemName: "goforward.15")
                    }
                }
                .foregroundStyle(.white)
                .font(.system(size: 18, weight: .medium))
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
            .padding(.bottom, 18)
        }
        .frame(maxWidth: .infinity)
        .background(theme.resolvedSurface)
        .clipShape(RoundedRectangle(cornerRadius: 0))
    }
}
