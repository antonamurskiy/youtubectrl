import { useEffect, useRef } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import { isNativeIOS, NativePlayer } from '../native/player'

// Pushes the currently-playing video's metadata to iOS Now Playing
// (lock screen + Control Center artwork + scrubber).
// Also wires native remote commands (lock-screen buttons, AirPods) to the
// app's existing play/pause/seek flow.
export function useNativeNowPlaying({ send }) {
  const title = usePlaybackStore(s => s.title)
  const channel = usePlaybackStore(s => s.channel)
  const thumbnail = usePlaybackStore(s => s.thumbnail)
  const duration = usePlaybackStore(s => s.duration)
  const isLive = usePlaybackStore(s => s.isLive)
  const playing = usePlaybackStore(s => s.playing)
  const paused = usePlaybackStore(s => s.paused)

  const lastPushedPositionRef = useRef(0)
  const lastPushedAtRef = useRef(0)

  // Push metadata on meaningful changes only — NOT on every-second position
  // ticks. iOS auto-advances the scrubber between updates based on rate;
  // we only resync when the user seeks (big jump), changes play/pause, or
  // the track changes.
  useEffect(() => {
    if (!isNativeIOS) return
    if (!playing || !title) {
      NativePlayer.clearNowPlaying().catch(() => {})
      return
    }
    const pos = usePlaybackStore.getState().position || 0
    NativePlayer.setNowPlaying({
      title,
      artist: channel || '',
      artworkUrl: thumbnail || '',
      duration: duration || 0,
      position: pos,
      isLive: !!isLive,
      paused: !!paused,
    }).catch(() => {})
    lastPushedPositionRef.current = pos
    lastPushedAtRef.current = Date.now()
  }, [title, channel, thumbnail, duration, isLive, playing, paused])

  // Detect manual seeks: if the observed position jumps more than 3s
  // away from where iOS thinks we are (our last push + elapsed wall time
  // assuming rate=1), push a fresh position so the scrubber snaps.
  useEffect(() => {
    if (!isNativeIOS) return
    const iv = setInterval(() => {
      const st = usePlaybackStore.getState()
      if (!st.playing || !st.title) return
      const pos = st.position || 0
      const expected = st.paused
        ? lastPushedPositionRef.current
        : lastPushedPositionRef.current + (Date.now() - lastPushedAtRef.current) / 1000
      const delta = Math.abs(pos - expected)
      if (delta > 3) {
        NativePlayer.setNowPlaying({
          title: st.title,
          artist: st.channel || '',
          artworkUrl: st.thumbnail || '',
          duration: st.duration || 0,
          position: pos,
          isLive: !!st.isLive,
          paused: !!st.paused,
        }).catch(() => {})
        lastPushedPositionRef.current = pos
        lastPushedAtRef.current = Date.now()
      }
    }, 2000)
    return () => clearInterval(iv)
  }, [])

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
