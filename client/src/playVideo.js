import { useSyncStore } from './stores/sync'
import { usePlaybackStore } from './stores/playback'

// Unified entry point for "start playing this video". Routes based on
// current mode:
//   - phone-only (phoneOnlyUrl set) → update phoneOnlyUrl + pb so
//     PhonePlayer's effect re-runs and AVPlayer loads the new item,
//     which also updates any active PiP overlay in place.
//   - otherwise → POST /api/play (mpv on the Mac). In sync mode the
//     PhonePlayer sync loop picks up pb.url changing and issues
//     NativePlayer.load itself, so PiP follows there too.
//
// `video` shape: { url, title, channel, thumbnail, isLive|live, startPercent }
export function playVideo(video) {
  const videoUrl = video.url || (video.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : '')
  if (!videoUrl) return Promise.reject(new Error('no url'))

  if (useSyncStore.getState().phoneOnlyUrl) {
    usePlaybackStore.getState().update({
      playing: true, paused: false, url: videoUrl,
      title: video.title || '', channel: video.channel || '',
      thumbnail: video.thumbnail || '',
      isLive: !!(video.isLive || video.live),
      position: 0, duration: 0,
    })
    useSyncStore.getState().setPhoneOnly(videoUrl)
    return Promise.resolve({ ok: true, mode: 'phone-only' })
  }

  return fetch('/api/play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: videoUrl,
      title: video.title || '',
      channel: video.channel || '',
      thumbnail: video.thumbnail || '',
      isLive: !!(video.isLive || video.live),
      watchPct: video.startPercent || 0,
    }),
  })
}
