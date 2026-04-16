import { useEffect, useRef } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { isNativeIOS, NativePlayer } from '../native/player'

// Runs a Live Activity on the lock screen / Dynamic Island matching the
// currently-playing video. Includes volume (from periodic polling) and
// basic metadata + play/pause state.
export function useLiveActivity() {
  const startedRef = useRef(false)
  const lastKeyRef = useRef('')
  const volumeRef = useRef(50)

  const title = usePlaybackStore(s => s.title)
  const channel = usePlaybackStore(s => s.channel)
  const thumbnail = usePlaybackStore(s => s.thumbnail)
  const duration = usePlaybackStore(s => s.duration)
  const position = usePlaybackStore(s => s.position)
  const isLive = usePlaybackStore(s => s.isLive)
  const paused = usePlaybackStore(s => s.paused)
  const playing = usePlaybackStore(s => s.playing)

  // Poll Mac volume in the background so the slider reflects actual state
  useEffect(() => {
    if (!isNativeIOS) return
    let alive = true
    const fetchVol = async () => {
      if (!alive) return
      try {
        const r = await fetch('/api/volume-status').then(r => r.json())
        if (typeof r.volume === 'number') {
          volumeRef.current = r.volume
          // If activity is running, push the volume update
          if (startedRef.current) {
            NativePlayer.updateLiveActivity({ volume: r.volume }).catch(() => {})
          }
        }
      } catch {}
    }
    fetchVol()
    const iv = setInterval(fetchVol, 4000)
    // Also react to local volume changes triggered by buttons
    const onVol = (e) => {
      if (typeof e.detail?.volume === 'number') {
        volumeRef.current = e.detail.volume
        if (startedRef.current) {
          NativePlayer.updateLiveActivity({ volume: e.detail.volume }).catch(() => {})
        }
      }
    }
    window.addEventListener('mac-volume', onVol)
    return () => {
      alive = false
      clearInterval(iv)
      window.removeEventListener('mac-volume', onVol)
    }
  }, [])

  // Start / update / end based on playback state
  useEffect(() => {
    if (!isNativeIOS) return
    const info = {
      title: title || '',
      channel: channel || '',
      artworkUrl: thumbnail || '',
      volume: volumeRef.current,
      paused: !!paused,
      position: position || 0,
      duration: duration || 0,
      isLive: !!isLive,
    }
    const key = `${playing}:${info.title}`
    if (!playing || !title) {
      if (startedRef.current) {
        NativePlayer.endLiveActivity().catch(() => {})
        startedRef.current = false
        lastKeyRef.current = ''
      }
      return
    }
    if (!startedRef.current || lastKeyRef.current !== key) {
      // New video — restart activity with fresh static attributes
      if (startedRef.current) NativePlayer.endLiveActivity().catch(() => {})
      NativePlayer.startLiveActivity(info).then(r => {
        if (r?.ok) {
          startedRef.current = true
          lastKeyRef.current = key
        }
      }).catch(() => {})
    } else {
      NativePlayer.updateLiveActivity(info).catch(() => {})
    }
  }, [title, channel, thumbnail, duration, isLive, paused, playing, position])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (startedRef.current) NativePlayer.endLiveActivity().catch(() => {})
    }
  }, [])
}
