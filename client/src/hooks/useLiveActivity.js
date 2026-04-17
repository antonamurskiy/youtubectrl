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

  // Volume: seed the widget's volume once from the server at start, then
  // only react to local 'mac-volume' events (fired by hardware volume
  // buttons + secret menu slider). Polling was racing with the widget's
  // own AppIntent writes and pulling it out of sync.
  useEffect(() => {
    if (!isNativeIOS) return
    const pushVolume = (v) => {
      if (v === volumeRef.current) return
      volumeRef.current = v
      if (!startedRef.current) return
      NativePlayer.updateLiveActivity({ volume: v }).catch(() => {})
      lastPushedRef.current.volume = v
    }
    // Initial fetch only
    fetch('/api/volume-status').then(r => r.json()).then(r => {
      if (typeof r.volume === 'number') pushVolume(r.volume)
    }).catch(() => {})
    const onVol = (e) => {
      if (typeof e.detail?.volume === 'number') pushVolume(e.detail.volume)
    }
    window.addEventListener('mac-volume', onVol)
    return () => window.removeEventListener('mac-volume', onVol)
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

  // Heartbeat: re-push `paused` every 3s while the activity is alive.
  // iOS throttles Live Activity updates to ~1/sec from a backgrounded app,
  // so a `paused` change landing on a busy tick gets silently dropped. The
  // diff logic above still marks it as "pushed", producing a permanent
  // desync until the next toggle. Periodic reconciliation ensures the
  // widget eventually catches up.
  useEffect(() => {
    if (!isNativeIOS) return
    const id = setInterval(() => {
      if (!startedRef.current) return
      const want = !!paused
      if (lastPushedRef.current.paused === want) {
        // Re-send anyway occasionally — cheap and corrects any silent drop
        NativePlayer.updateLiveActivity({ paused: want }).catch(() => {})
      } else {
        NativePlayer.updateLiveActivity({ paused: want }).catch(() => {})
        lastPushedRef.current.paused = want
      }
    }, 3000)
    return () => clearInterval(id)
  }, [paused])

  useEffect(() => {
    return () => {
      if (startedRef.current) NativePlayer.endLiveActivity().catch(() => {})
    }
  }, [])
}
