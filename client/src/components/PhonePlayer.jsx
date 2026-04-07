import { useState, useRef, useEffect, useCallback } from 'react'
import Hls from 'hls.js'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import { useUIStore } from '../stores/ui'

export default function PhonePlayer({ send }) {
  const videoRef = useRef(null)
  const userOffsetRef = useRef(0)
  const [streamUrl, setStreamUrl] = useState(null)
  const [isLive, setIsLive] = useState(false)
  const [loading, setLoading] = useState(true)

  const phoneOpen = useSyncStore(s => s.phoneOpen)
  const setPhoneOpen = useSyncStore(s => s.setPhoneOpen)
  const addToast = useUIStore(s => s.addToast)

  // Fetch stream URL on open
  useEffect(() => {
    if (!phoneOpen) return
    setLoading(true)

    fetch('/api/watch-on-phone', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (data.streamUrl) {
          setIsLive(!!data.isLive)
          // Always use lightweight proxy (full YouTube manifest is 5MB, stalls Safari)
          const url = data.isLive ? (data.proxyUrl || data.streamUrl) : data.streamUrl
          setStreamUrl(url)

          // Defer setup to next tick so React has rendered the video element
          setTimeout(() => {
            const video = videoRef.current
            if (!video) { console.error('PHONE: no video ref'); return }
            const fullUrl = url.startsWith('/') ? `${location.origin}${url}` : url
            if (data.isLive && Hls.isSupported()) {
              if (video._hls) { video._hls.destroy(); video._hls = null }
              const hls = new Hls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 6 })
              hls.loadSource(fullUrl)
              hls.attachMedia(video)
              hls.on(Hls.Events.MANIFEST_PARSED, () => {
                video.play().catch(e => console.error('PHONE play error:', e))
              })
              hls.on(Hls.Events.ERROR, (_, d) => console.error('HLS error:', d.type, d.details))
              video._hls = hls
            } else {
              video.src = fullUrl
              if (data.seconds) video.currentTime = data.seconds
              video.play().catch(e => console.error('PHONE play error:', e))
            }
          }, 100)
        }
        setLoading(false)
      })
      .catch(() => { addToast('Failed to get stream'); setLoading(false) })
  }, [phoneOpen, addToast])

  // Imperative sync loop — reads store directly, no subscriptions that cause re-renders
  useEffect(() => {
    if (!phoneOpen) return

    let lastRateSend = 0
    const setDrift = (text) => { const el = document.getElementById('drift-display'); if (el) el.textContent = text }

    window._nudgeOffset = (delta) => {
      userOffsetRef.current = +(userOffsetRef.current + delta).toFixed(1)
      const el = document.getElementById('offset-display')
      if (el) el.textContent = `offset: ${userOffsetRef.current.toFixed(1)}s`
    }

    let tick = 0
    const interval = setInterval(() => {
      tick++
      const video = videoRef.current
      const pb = usePlaybackStore.getState()
      // Always show debug status
      setDrift(`t${tick} v:${!!video} ct:${video?.currentTime?.toFixed(0)||'?'} p:${pb.playing} l:${pb.isLive} h:${!!video?._hls}`)
      if (!video) return
      if (!pb.playing || pb.paused) return

      const behindLive = pb.duration - pb.position

      if (pb.isLive) {
        // Compare "seconds behind live edge"
        const vlcBehind = pb.vlcBehind || 0 // real behind-live from server (includes VLC buffering)
        // Phone's behind-live: seekable end - currentTime
        let phoneBehind = 0
        if (video.seekable?.length > 0) {
          phoneBehind = video.seekable.end(video.seekable.length - 1) - video.currentTime
        } else {
          setDrift('no seekable')
          return
        }
        // drift > 0 means VLC is further behind live than phone (phone is ahead)
        const drift = vlcBehind - phoneBehind + userOffsetRef.current
        if (Math.abs(drift) > 300) return // filter garbage

        setDrift(`drift: ${drift.toFixed(1)}s (vlc:-${vlcBehind.toFixed(0)} ph:-${phoneBehind.toFixed(0)})`)
        send({ type: 'phone-state', drift: +drift.toFixed(2), vlcBehind: +vlcBehind.toFixed(0), phoneBehind: +phoneBehind.toFixed(0) })

        if (behindLive > 5) return

        const now = Date.now()
        if (now - lastRateSend < 1000) return
        lastRateSend = now

        if (Math.abs(drift) > 0.1) {
          const rate = Math.max(0.9, Math.min(1.1, 1.0 - drift * 0.1))
          send({ type: 'vlc-rate', rate: +rate.toFixed(4) })
        } else {
          send({ type: 'vlc-rate', rate: 1.0 })
        }
      } else {
        // VOD sync
        const drift = pb.position - video.currentTime
        setDrift(`drift: ${drift.toFixed(1)}s`)
        send({ type: 'phone-state', drift: +drift.toFixed(2) })

        if (Math.abs(drift) > 5) {
          video.currentTime = pb.position
        } else if (Math.abs(drift) > 0.5) {
          const now = Date.now()
          if (now - lastRateSend < 1000) return
          lastRateSend = now
          const rate = Math.max(0.9, Math.min(1.1, 1.0 - drift * 0.05))
          send({ type: 'mpv-speed', speed: +rate.toFixed(4) })
        }
      }
    }, 1000)

    return () => {
      clearInterval(interval)
      delete window._nudgeOffset
    }
  }, [phoneOpen, send])

  const handleClose = useCallback(() => {
    fetch('/api/stop-phone-stream', { method: 'POST' }).catch(() => {})
    send({ type: 'vlc-rate', rate: 1.0 })
    send({ type: 'mpv-speed', speed: 1.0 })
    setPhoneOpen(false)
    setStreamUrl(null)
    setIsLive(false)
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.removeAttribute('src')
      videoRef.current.load()
    }
  }, [setPhoneOpen, send])

  if (!phoneOpen) return null

  return (
    <div className="phone-player">
      <video
        ref={videoRef}
        playsInline
        autoPlay
        muted
        controls
        style={{ width: '100%', maxHeight: '30vh', display: 'block', background: '#000' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', background: '#111', fontSize: '12px', fontFamily: 'monospace' }}>
        <span id="drift-display" style={{ color: '#0f0' }}>drift: --</span>
        {isLive && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button onClick={() => window._nudgeOffset?.(-0.5)} style={{ padding: '6px 12px', background: '#333', color: '#fff', border: '1px solid #555' }}>-0.5</button>
            <span id="offset-display" style={{ color: '#ff0' }}>offset: 0.0s</span>
            <button onClick={() => window._nudgeOffset?.(0.5)} style={{ padding: '6px 12px', background: '#333', color: '#fff', border: '1px solid #555' }}>+0.5</button>
          </div>
        )}
        <button onClick={handleClose} style={{ padding: '6px 12px', background: '#333', color: '#f33', border: '1px solid #555' }}>CLOSE</button>
      </div>
    </div>
  )
}
