import ActivityKit
import WidgetKit
import SwiftUI
import AppIntents

@available(iOS 16.1, *)
struct YouTubeCtrlLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: YouTubeCtrlActivityAttributes.self) { context in
            LockScreenView(state: context.state)
                .activityBackgroundTint(Color.black.opacity(0.9))
                .activitySystemActionForegroundColor(Color.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    AsyncImage(url: URL(string: context.state.artworkUrl)) { img in
                        img.resizable().aspectRatio(contentMode: .fit)
                    } placeholder: { Color.gray.opacity(0.3) }
                        .frame(width: 40, height: 40)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if #available(iOS 17.0, *) {
                        Button(intent: YTCtrlPlayPauseIntent()) {
                            Image(systemName: context.state.paused ? "play.fill" : "pause.fill")
                                .font(.title2)
                        }
                        .buttonStyle(.plain)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 4) {
                        Text(context.state.title).font(.caption).lineLimit(1)
                        VolumeRow(volume: context.state.volume)
                    }
                }
            } compactLeading: {
                Image(systemName: "play.rectangle.fill").foregroundColor(.red)
            } compactTrailing: {
                Text("\(context.state.volume)%").font(.caption2)
            } minimal: {
                Image(systemName: "speaker.wave.2.fill")
            }
        }
    }
}

@available(iOS 16.1, *)
private struct LockScreenView: View {
    let state: YouTubeCtrlActivityAttributes.ContentState
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                AsyncImage(url: URL(string: state.artworkUrl)) { img in
                    img.resizable().aspectRatio(contentMode: .fill)
                } placeholder: {
                    Color.gray.opacity(0.3)
                }
                .frame(width: 56, height: 56)
                .cornerRadius(4)
                .clipped()
                VStack(alignment: .leading, spacing: 3) {
                    Text(state.title).font(.system(size: 14, weight: .semibold)).lineLimit(2)
                    Text(state.channel).font(.system(size: 12)).foregroundColor(.secondary).lineLimit(1)
                }
                Spacer()
                if #available(iOS 17.0, *) {
                    Button(intent: YTCtrlPlayPauseIntent()) {
                        Image(systemName: state.paused ? "play.fill" : "pause.fill")
                            .font(.system(size: 28))
                            .foregroundColor(.white)
                    }
                    .buttonStyle(.plain)
                }
            }
            VolumeRow(volume: state.volume)
        }
        .padding(12)
    }
}

@available(iOS 16.1, *)
private struct VolumeRow: View {
    let volume: Int
    var body: some View {
        HStack(spacing: 8) {
            if #available(iOS 17.0, *) {
                Button(intent: YTCtrlVolumeIntent(delta: -10)) {
                    Image(systemName: "speaker.wave.1.fill").foregroundColor(.white.opacity(0.8))
                }.buttonStyle(.plain)
            } else {
                Image(systemName: "speaker.wave.1.fill").foregroundColor(.white.opacity(0.8))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.15)).frame(height: 4)
                    Capsule().fill(Color.white).frame(width: geo.size.width * CGFloat(volume) / 100, height: 4)
                }.frame(maxHeight: .infinity, alignment: .center)
            }
            .frame(height: 20)
            if #available(iOS 17.0, *) {
                Button(intent: YTCtrlVolumeIntent(delta: 10)) {
                    Image(systemName: "speaker.wave.3.fill").foregroundColor(.white.opacity(0.8))
                }.buttonStyle(.plain)
            } else {
                Image(systemName: "speaker.wave.3.fill").foregroundColor(.white.opacity(0.8))
            }
            Text("\(volume)%").font(.system(size: 11, weight: .medium).monospacedDigit()).foregroundColor(.white.opacity(0.7))
        }
    }
}
