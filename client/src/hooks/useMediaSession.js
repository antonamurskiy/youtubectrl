import { useEffect, useRef } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'

export function useMediaSession() {
  const silentAudioRef = useRef(null)
  const activeRef = useRef(false)
  const posRef = useRef(0)
  const durRef = useRef(0)

  useEffect(() => {
    if (!('mediaSession' in navigator) || !('ontouchstart' in window)) return

    const audio = new Audio('/silent.m4a')
    audio.volume = 1
    silentAudioRef.current = audio
    useSyncStore.getState().setSilentAudioRef(audio)

    // iOS requires audio.play() from a user gesture to unlock the audio element.
    // Once unlocked, subsequent play() calls from non-gesture contexts work.
    const unlock = () => {
      audio.play().then(() => {
        // Unlocked — if not active yet, pause until playback starts
        if (!activeRef.current) { audio.pause(); audio.currentTime = 0 }
      }).catch(() => {})
      document.removeEventListener('touchstart', unlock, true)
      document.removeEventListener('click', unlock, true)
    }
    document.addEventListener('touchstart', unlock, true)
    document.addEventListener('click', unlock, true)

    // Restart loop — set position state before restarting to prevent flash to 0
    const handleEnded = () => {
      if (!activeRef.current) return
      if (durRef.current > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration: durRef.current,
            playbackRate: 1,
            position: Math.max(0, Math.min(posRef.current, durRef.current)),
          })
        } catch {}
      }
      audio.currentTime = 0
      audio.play().catch(() => {})
    }
    audio.addEventListener('ended', handleEnded)

    // Register action handlers
    navigator.mediaSession.setActionHandler('play', () => {
      // Touch audio synchronously first — iOS kills the session if we await before play()
      audio.play().catch(() => {})
      navigator.mediaSession.playbackState = 'playing'
      fetch('/api/resume', { method: 'POST' })
    })
    navigator.mediaSession.setActionHandler('pause', () => {
      audio.pause()
      navigator.mediaSession.playbackState = 'paused'
      fetch('/api/pause', { method: 'POST' })
    })
    navigator.mediaSession.setActionHandler('seekbackward', () => {
      fetch('/api/seek-relative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: -10 }),
      })
    })
    navigator.mediaSession.setActionHandler('seekforward', () => {
      fetch('/api/seek-relative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: 10 }),
      })
    })
    navigator.mediaSession.setActionHandler('stop', () => {
      fetch('/api/stop', { method: 'POST' })
    })
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) {
        posRef.current = details.seekTime
        try {
          navigator.mediaSession.setPositionState({
            duration: durRef.current,
            playbackRate: 1,
            position: Math.max(0, Math.min(details.seekTime, durRef.current)),
          })
        } catch {}
        fetch('/api/seek', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ position: details.seekTime }),
        })
      }
    })

    // Subscribe to playback store updates
    const unsub = usePlaybackStore.subscribe((pb) => {
      const wasActive = activeRef.current

      if (pb.playing && pb.url) {
        posRef.current = pb.position || 0
        durRef.current = pb.duration || 0

        // Activate if not already
        if (!wasActive) {
          activeRef.current = true
          audio.play().catch(() => {})
        }

        // Update metadata
        const videoId = pb.url.match(/[?&]v=([\w-]+)/)?.[1]
        const artwork = videoId
          ? [{ src: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' }]
          : []
        navigator.mediaSession.metadata = new MediaMetadata({
          title: pb.title || 'YouTubeCtrl',
          artist: pb.channel || '',
          album: 'YouTubeCtrl',
          artwork,
        })

        // Update position & play state
        navigator.mediaSession.playbackState = pb.paused ? 'paused' : 'playing'
        if (pb.paused) {
          audio.pause()
        } else if (audio.paused && activeRef.current) {
          audio.play().catch(() => {})
        }
        if (pb.duration > 0 && isFinite(pb.duration) && isFinite(pb.position)) {
          try {
            navigator.mediaSession.setPositionState({
              duration: pb.duration,
              playbackRate: 1,
              position: Math.max(0, Math.min(pb.position, pb.duration)),
            })
          } catch {}
        }
      } else if (wasActive) {
        // Deactivate
        activeRef.current = false
        audio.pause()
        audio.currentTime = 0
        navigator.mediaSession.metadata = null
        navigator.mediaSession.playbackState = 'none'
      }
    })

    return () => {
      unsub()
      audio.removeEventListener('ended', handleEnded)
      document.removeEventListener('touchstart', unlock, true)
      document.removeEventListener('click', unlock, true)
      audio.pause()
      activeRef.current = false
    }
  }, [])
}
