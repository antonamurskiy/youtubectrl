import { useEffect, useRef, useCallback } from 'react'
import Hls from 'hls.js'

export function useHlsPlayer(videoRef, src) {
  const hlsRef = useRef(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    // Cleanup previous instance
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    if (Hls.isSupported()) {
      // Chrome, Firefox, etc. — use hls.js for proper DVR support
      const hls = new Hls({
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        enableWorker: true,
        lowLatencyMode: false,
      })
      hls.loadSource(src)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {})
      })
      hlsRef.current = hls
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari — native HLS (also supports hls.js playingDate equivalent via getStartDate)
      video.src = src
      video.addEventListener('loadedmetadata', () => {
        video.play().catch(() => {})
      }, { once: true })
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [src, videoRef])

  // Get absolute playback time (PDT-based) — works on both Chrome (hls.js) and Safari (native)
  const getPlayingDate = useCallback(() => {
    const hls = hlsRef.current
    const video = videoRef.current
    if (!video) return null

    if (hls) {
      // hls.js: playingDate gives PDT-based absolute time
      return hls.playingDate?.getTime() || null
    }

    // Safari native: getStartDate() + currentTime
    try {
      const sd = video.getStartDate?.()
      if (sd && !isNaN(sd.getTime())) {
        return sd.getTime() + video.currentTime * 1000
      }
    } catch {}
    return null
  }, [videoRef])

  // Seek within DVR window
  const seekTo = useCallback((seconds) => {
    const video = videoRef.current
    if (video) video.currentTime = seconds
  }, [videoRef])

  // Get seekable range (for live DVR)
  const getSeekableEnd = useCallback(() => {
    const video = videoRef.current
    if (!video || !video.seekable?.length) return 0
    return video.seekable.end(video.seekable.length - 1)
  }, [videoRef])

  return { hlsRef, getPlayingDate, seekTo, getSeekableEnd }
}
