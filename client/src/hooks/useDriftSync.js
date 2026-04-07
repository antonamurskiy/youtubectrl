import { useEffect, useRef } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'

export function useDriftSync(videoRef, getPlayingDate, send) {
  const correcting = useRef(false)

  useEffect(() => {
    // Subscribe to playback store updates (driven by WS at 100ms)
    const unsub = usePlaybackStore.subscribe((pb) => {
      if (!pb.playing || pb.paused) return
      const video = videoRef.current
      if (!video || video.readyState < 2 || video.currentTime < 1) return

      const sync = useSyncStore.getState()
      if (!sync.phoneOpen) return
      if (Date.now() < sync.settleUntil) return

      const behindLive = pb.duration - pb.position

      if (pb.isLive) {
        syncLive(pb, video, getPlayingDate, send, sync, behindLive)
      } else {
        syncVod(pb, video, send, sync)
      }
    })

    return unsub
  }, [videoRef, getPlayingDate, send])
}

function syncLive(pb, video, getPlayingDate, send, sync, behindLive) {
  // Get absolute time from hls.js (Chrome) or native (Safari)
  const phoneAbsMs = getPlayingDate()
  if (!phoneAbsMs || !pb.absoluteMs) return

  const rawDrift = (pb.absoluteMs - phoneAbsMs) / 1000

  // Calibrate baseline on first stable measurement
  const store = useSyncStore.getState()
  if (store.baseline === null) {
    store.setBaseline(rawDrift)
    return
  }

  const drift = rawDrift - store.baseline
  store.setDrift(drift)

  // Skip corrections when behind live (phone already seeked, VLC PTS unreliable)
  if (behindLive > 5) return

  // Proportional VLC rate control
  if (Math.abs(drift) > 0.1) {
    const rate = Math.max(0.9, Math.min(1.1, 1.0 - drift * 0.05))
    send({ type: 'vlc-rate', rate: +rate.toFixed(4) })
  } else {
    send({ type: 'vlc-rate', rate: 1.0 })
  }
}

function syncVod(pb, video, send, sync) {
  const drift = pb.position - video.currentTime
  useSyncStore.getState().setDrift(drift)

  // Pause/resume
  if (pb.paused && !video.paused) video.pause()
  else if (!pb.paused && video.paused) video.play().catch(() => {})

  if (Math.abs(drift) > 5) {
    // Large drift: hard seek
    video.currentTime = pb.position
    useSyncStore.getState().setSettling(Date.now() + 3000)
  } else if (Math.abs(drift) > 0.5) {
    // Proportional mpv speed control
    const rate = Math.max(0.9, Math.min(1.1, 1.0 - drift * 0.05))
    send({ type: 'mpv-speed', speed: +rate.toFixed(4) })
  } else {
    send({ type: 'mpv-speed', speed: 1.0 })
  }
}
