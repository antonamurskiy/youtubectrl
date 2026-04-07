import { useEffect, useRef, useCallback } from 'react'
import Hls from 'hls.js'

export function useHlsPlayer(videoRef, src) {
  const hlsRef = useRef(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    // Resolve relative URLs to absolute (Safari native HLS needs full URL)
    const absoluteSrc = src.startsWith('/') ? `${location.origin}${src}` : src

    // Cleanup previous instance
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        enableWorker: true,
        lowLatencyMode: false,
      })
      hls.loadSource(absoluteSrc)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {})
      })
      hlsRef.current = hls
      video._hls = hls // expose for sync loop access
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
