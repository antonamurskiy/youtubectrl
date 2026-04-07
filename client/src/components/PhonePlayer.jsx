import { useState, useRef, useEffect, useCallback } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import { useUIStore } from '../stores/ui'
import { useHlsPlayer } from '../hooks/useHlsPlayer'
import { useDriftSync } from '../hooks/useDriftSync'

export default function PhonePlayer({ send }) {
  const videoRef = useRef(null)
  const [streamUrl, setStreamUrl] = useState(null)
  const [loading, setLoading] = useState(true)

  const pb = usePlaybackStore()
  const drift = useSyncStore(s => s.drift)
  const phoneOpen = useSyncStore(s => s.phoneOpen)
  const setPhoneOpen = useSyncStore(s => s.setPhoneOpen)
  const addToast = useUIStore(s => s.addToast)

  const { hlsRef, getPlayingDate, seekTo, getSeekableEnd } = useHlsPlayer(videoRef, pb.isLive ? streamUrl : null)

  // Use drift sync for live and VOD
  useDriftSync(videoRef, getPlayingDate, send)

  // Fetch stream URL on open
  useEffect(() => {
    if (!phoneOpen) return
    setLoading(true)

    fetch('/api/watch-on-phone', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (data.streamUrl) {
          setStreamUrl(data.streamUrl)
          // For VOD, set src directly on video element
          if (!data.isLive && videoRef.current) {
            videoRef.current.src = data.streamUrl
            if (data.seconds) {
              videoRef.current.currentTime = data.seconds
            }
            videoRef.current.play().catch(() => {})
          }
        }
        setLoading(false)
      })
      .catch(() => {
        addToast('Failed to get stream')
        setLoading(false)
      })
  }, [phoneOpen, addToast])

  // Sync VOD position from desktop player
  useEffect(() => {
    if (!phoneOpen || pb.isLive || !videoRef.current) return

    const video = videoRef.current
    if (pb.paused && !video.paused) video.pause()
    else if (!pb.paused && video.paused) video.play().catch(() => {})
  }, [pb.paused, pb.isLive, phoneOpen])

  const handleClose = useCallback(() => {
    fetch('/api/stop-phone-stream', { method: 'POST' }).catch(() => {})
    setPhoneOpen(false)
    setStreamUrl(null)

    // Stop video
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.removeAttribute('src')
      videoRef.current.load()
    }
  }, [setPhoneOpen])

  if (!phoneOpen) return null

  return (
    <div className="phone-player">
      <video
        ref={videoRef}
        playsInline
        autoPlay
        muted={false}
        style={{ width: '100%', maxHeight: '30vh', display: 'block', background: '#000' }}
      />
      <div className="phone-player-controls">
        <div className="drift-overlay">
          {loading ? 'Loading...' : (
            <>
              drift: {drift.toFixed(3)}s
              {pb.isLive && ' | LIVE'}
            </>
          )}
        </div>
        <button className="phone-player-close" onClick={handleClose}>
          CLOSE
        </button>
      </div>
    </div>
  )
}
