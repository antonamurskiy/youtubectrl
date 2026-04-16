import { useEffect, useRef } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { isNativeIOS, NativePlayer } from '../native/player'

// Live Activity lifecycle — keeps the lock-screen widget in sync with
// playback state and Mac volume, without fighting the widget's own
// AppIntent updates (volume ± buttons).
//
// Key rule: only send fields that CHANGED since last update. The widget's
// AppIntents may have independently moved volume via read-modify-write,
// and we don't want to clobber that with a stale value.
export function useLiveActivity() {
  const startedRef = useRef(false)
  const lastKeyRef = useRef('')
  // Last values we successfully pushed — used for diffing
  const lastPushedRef = useRef({})
  const volumeRef = useRef(null)

  const title = usePlaybackStore(s => s.title)
  const channel = usePlaybackStore(s => s.channel)
  const thumbnail = usePlaybackStore(s => s.thumbnail)
  const duration = usePlaybackStore(s => s.duration)
  const isLive = usePlaybackStore(s => s.isLive)
  const paused = usePlaybackStore(s => s.paused)
  const playing = usePlaybackStore(s => s.playing)

  // Poll Mac volume so the slider reflects actual state
  useEffect(() => {
    if (!isNativeIOS) return
    let alive = true
    const pushVolume = (v) => {
      if (v === volumeRef.current) return
      volumeRef.current = v
      if (!startedRef.current) return
      // Only send the volume field — don't clobber paused/position/etc
      NativePlayer.updateLiveActivity({ volume: v }).catch(() => {})
      lastPushedRef.current.volume = v
    }
    const fetchVol = async () => {
      if (!alive) return
      try {
        const r = await fetch('/api/volume-status').then(r => r.json())
        if (typeof r.volume === 'number') pushVolume(r.volume)
      } catch {}
    }
    fetchVol()
    const iv = setInterval(fetchVol, 8000)
    const onVol = (e) => {
      if (typeof e.detail?.volume === 'number') pushVolume(e.detail.volume)
    }
    window.addEventListener('mac-volume', onVol)
    return () => {
      alive = false
      clearInterval(iv)
      window.removeEventListener('mac-volume', onVol)
    }
  }, [])

  // Start / update / end based on playback metadata changes.
  // Note: no `position` in deps — position changes every second and was
  // spamming the activity with updates that iOS had to rate-limit.
  useEffect(() => {
    if (!isNativeIOS) return

    const key = `${playing}:${title}`

    if (!playing || !title) {
      if (startedRef.current) {
        NativePlayer.endLiveActivity().catch(() => {})
        startedRef.current = false
        lastKeyRef.current = ''
        lastPushedRef.current = {}
      }
      return
    }

    // Full info used for start; partial diff used for update
    const fullInfo = {
      title: title || '',
      channel: channel || '',
      artworkUrl: thumbnail || '',
      volume: volumeRef.current ?? 50,
      paused: !!paused,
      duration: duration || 0,
      isLive: !!isLive,
    }

    if (!startedRef.current || lastKeyRef.current !== key) {
      if (startedRef.current) NativePlayer.endLiveActivity().catch(() => {})
      NativePlayer.startLiveActivity(fullInfo).then(r => {
        if (r?.ok) {
          startedRef.current = true
          lastKeyRef.current = key
          lastPushedRef.current = { ...fullInfo }
        }
      }).catch(() => {})
      return
    }

    // Build a diff of only fields that differ from last-pushed values.
    const diff = {}
    const last = lastPushedRef.current
    for (const k of ['title', 'channel', 'artworkUrl', 'paused', 'duration', 'isLive']) {
      if (fullInfo[k] !== last[k]) diff[k] = fullInfo[k]
    }
    if (Object.keys(diff).length === 0) return
    NativePlayer.updateLiveActivity(diff).catch(() => {})
    Object.assign(lastPushedRef.current, diff)
  }, [title, channel, thumbnail, duration, isLive, paused, playing])

  useEffect(() => {
    return () => {
      if (startedRef.current) NativePlayer.endLiveActivity().catch(() => {})
    }
  }, [])
}
