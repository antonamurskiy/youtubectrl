import { useEffect } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import { isNativeIOS, NativePlayer } from '../native/player'

// Pushes the currently-playing video's metadata to iOS Now Playing
// (lock screen + Control Center artwork + scrubber).
// Also wires native remote commands (lock-screen buttons, AirPods) to the
// app's existing play/pause/seek flow.
export function useNativeNowPlaying({ send }) {
  // Subscribe granularly — fields that iOS re-renders when they change
  const title = usePlaybackStore(s => s.title)
  const channel = usePlaybackStore(s => s.channel)
  const thumbnail = usePlaybackStore(s => s.thumbnail)
  const duration = usePlaybackStore(s => s.duration)
  const position = usePlaybackStore(s => s.position)
  const isLive = usePlaybackStore(s => s.isLive)
  const playing = usePlaybackStore(s => s.playing)
  const paused = usePlaybackStore(s => s.paused)
  const phoneOpen = useSyncStore(s => s.phoneOpen)

  // Push metadata (artwork only refetches when thumbnail URL changes)
  useEffect(() => {
    if (!isNativeIOS) return
    if (!playing || !title) {
      NativePlayer.clearNowPlaying().catch(() => {})
      return
    }
    NativePlayer.setNowPlaying({
      title,
      artist: channel || '',
      artworkUrl: thumbnail || '',
      duration: duration || 0,
      position: position || 0,
      isLive: !!isLive,
      paused: !!paused,
    }).catch(() => {})
  }, [title, channel, thumbnail, duration, isLive, playing, paused])

  // Wire native remote commands to the app's existing control endpoints.
  // When phone mode is active, local PhonePlayer handles it; when not, we
  // poke the server's /api/playpause etc which drive mpv.
  useEffect(() => {
    if (!isNativeIOS) return
    const handlers = []

    const togglePlayPause = () => {
      const ctrl = useSyncStore.getState().phoneVideoCtrl
      if (ctrl) {
        const pb = usePlaybackStore.getState()
        if (pb.paused) ctrl.play?.(); else ctrl.pause?.()
      } else {
        fetch('/api/playpause', { method: 'POST' }).catch(() => {})
      }
    }

    const skip = (delta) => {
      const ctrl = useSyncStore.getState().phoneVideoCtrl
      if (ctrl?.skip) ctrl.skip(delta)
      else fetch('/api/seek-relative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: delta }),
      }).catch(() => {})
    }

    handlers.push(NativePlayer.addListener('remotePlay', togglePlayPause))
    handlers.push(NativePlayer.addListener('remotePause', togglePlayPause))
    handlers.push(NativePlayer.addListener('remoteTogglePlayPause', togglePlayPause))
    handlers.push(NativePlayer.addListener('remoteSkip', ({ delta }) => skip(delta || 0)))
    handlers.push(NativePlayer.addListener('remoteSeek', ({ position }) => {
      const ctrl = useSyncStore.getState().phoneVideoCtrl
      if (ctrl?.seek) ctrl.seek(position)
      else fetch('/api/seek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position }),
      }).catch(() => {})
    }))

    return () => {
      handlers.forEach(h => { Promise.resolve(h).then(res => res?.remove?.()).catch(() => {}) })
    }
  }, [])
}
