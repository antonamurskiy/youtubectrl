import { useState, useRef, useEffect, useCallback } from 'react'
import Hls from 'hls.js'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import { useUIStore } from '../stores/ui'

export default function PhonePlayer({ send }) {
  const videoRef = useRef(null)
  const userOffsetRef = useRef(0)
  const readyRef = useRef(false) // true after video starts playing for the first time
  const readyAtRef = useRef(0) // timestamp when video became ready
  const calibOffsetRef = useRef(null) // one-time PDT calibration offset (ms)
  const driftSamplesRef = useRef([]) // moving average for smooth drift display
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
          // hls.js (Chrome) needs proxy for CORS, native Safari plays YouTube directly
          const useHls = data.isLive && Hls.isSupported()
          const url = useHls ? (data.proxyUrl || data.streamUrl) : data.streamUrl
          setStreamUrl(url)

          // Wait for VLC to start playing before loading phone video
          const waitForVlc = setInterval(() => {
            const pb = usePlaybackStore.getState()
            if (!pb.playing || pb.paused) return
            clearInterval(waitForVlc)

            setTimeout(() => {
              const video = videoRef.current
              if (!video) return
              const fullUrl = url.startsWith('/') ? `${location.origin}${url}` : url
              if (data.isLive && Hls.isSupported()) {
                if (video._hls) { video._hls.destroy(); video._hls = null }
                // Compute liveSyncDurationCount based on actual segment duration
                // VLC sits ~19s behind live — match that regardless of segment size
                const segDur = data.segDuration || 2
                const syncCount = Math.round(19 / segDur)
                const hls = new Hls({
                  liveSyncDurationCount: syncCount,
                  liveMaxLatencyDurationCount: syncCount + 6,
                  maxLiveSyncPlaybackRate: 1.04,
                  lowLatencyMode: false,
                })
                hls.loadSource(fullUrl)
                hls.attachMedia(video)
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                  video.play().then(() => { readyRef.current = true; readyAtRef.current = Date.now() }).catch(() => {})
                })
                video._hls = hls
              } else {
                video.src = fullUrl
                if (data.isLive) {
                  // Native Safari HLS: wait for loadedmetadata then seek behind live to match VLC
                  video.addEventListener('loadedmetadata', () => {
                    if (video.seekable?.length > 0) {
                      // VLC is ~19s behind live — match that
                      const seekableEnd = video.seekable.end(video.seekable.length - 1)
                      video.currentTime = Math.max(0, seekableEnd - 19)
                    }
                    video.play().then(() => { readyRef.current = true; readyAtRef.current = Date.now() }).catch(() => {})
                  }, { once: true })
                } else {
                  // VOD: seek to current mpv position
                  const currentPb = usePlaybackStore.getState()
                  video.currentTime = currentPb.position || data.seconds || 0
                  video.play().then(() => { readyRef.current = true; readyAtRef.current = Date.now() }).catch(() => {})
                }
              }
            }, 100)
          }, 500)
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
      const v = videoRef.current
      if (v) {
        // Seek the phone video directly — don't touch VLC
        v.currentTime += delta
      }
      userOffsetRef.current = +(userOffsetRef.current + delta).toFixed(1)
      // Re-calibrate drift baseline after manual offset
      calibOffsetRef.current = null
      driftSamplesRef.current = []
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
      if (!video || !readyRef.current) return
      const settleMs = Date.now() - readyAtRef.current
      if (settleMs < 5000) {
        setDrift(`settling ${((5000 - settleMs) / 1000).toFixed(0)}s...`)
        return // don't interfere during first 5s
      }
      if (!pb.playing || pb.paused) {
        if (!video.paused) video.pause()
        return
      }
      // Resume phone if mpv is playing but phone is paused
      if (video.paused) {
        if (pb.isLive) {
          // For live: resume and let sync loop correct position on next tick
        } else {
          video.currentTime = pb.position
        }
        video.play().catch(() => {})
        return
      }

      const behindLive = pb.duration - pb.position

      if (pb.isLive) {
        // PDT-based absolute time sync
        // Interpolate VLC time forward since last server update to avoid sawtooth
        const clockOffset = useSyncStore.getState().clockOffset || 0
        const elapsed = pb.serverTs ? Math.max(0, Math.min(Date.now() - pb.serverTs - clockOffset, 2000)) : 0
        const vlcAbsMs = pb.absoluteMs ? pb.absoluteMs + elapsed : null
        let phoneAbsMs = null

        // Try to get phone's absolute content time via PDT
        // hls.js: video.getStartDate() + currentTime (if manifest has PDT)
        // Native Safari: same API
        try {
          const startDate = video.getStartDate?.()
          if (startDate && !isNaN(startDate.getTime())) {
            phoneAbsMs = startDate.getTime() + video.currentTime * 1000
          }
        } catch {}

        if (vlcAbsMs && phoneAbsMs) {
          const rawOffset = vlcAbsMs - phoneAbsMs
          // Calibrate on first measurement — vlcPdtEpochMs has precision error so we
          // measure the baseline offset and track drift relative to it
          if (calibOffsetRef.current === null) {
            calibOffsetRef.current = rawOffset
            setDrift('calibrated')
            return
          }
          const rawDrift = (rawOffset - calibOffsetRef.current) / 1000 + userOffsetRef.current
          if (Math.abs(rawDrift) > 300) return
          // Smooth with 5-sample moving average to filter seekable.end() jitter
          driftSamplesRef.current.push(rawDrift)
          if (driftSamplesRef.current.length > 5) driftSamplesRef.current.shift()
          const drift = driftSamplesRef.current.reduce((a, b) => a + b, 0) / driftSamplesRef.current.length

          setDrift(`drift: ${drift.toFixed(1)}s`)
          send({ type: 'phone-state', drift: +drift.toFixed(2) })

          if (Math.abs(drift) > 5) {
            video.currentTime += drift
            calibOffsetRef.current = null
            driftSamplesRef.current = []
          }
        } else {
          // Fallback: behind-live comparison with calibration
          // vlcBehind doesn't include VLC's internal ~20s buffer, so calibrate
          const vlcBehind = pb.vlcBehind || 0
          let phoneBehind = 0
          if (video.seekable?.length > 0) {
            phoneBehind = video.seekable.end(video.seekable.length - 1) - video.currentTime
          }
          const rawDiff = vlcBehind - phoneBehind
          if (calibOffsetRef.current === null) {
            calibOffsetRef.current = rawDiff * 1000 // store in ms for consistency
            setDrift('calibrated')
            return
          }
          const rawDrift = rawDiff - calibOffsetRef.current / 1000 + userOffsetRef.current
          if (Math.abs(rawDrift) > 300) return
          driftSamplesRef.current.push(rawDrift)
          if (driftSamplesRef.current.length > 5) driftSamplesRef.current.shift()
          const drift = driftSamplesRef.current.reduce((a, b) => a + b, 0) / driftSamplesRef.current.length

          setDrift(`drift: ${drift.toFixed(1)}s`)
          send({ type: 'phone-state', drift: +drift.toFixed(2) })

          if (Math.abs(drift) > 5) {
            video.currentTime += drift
            calibOffsetRef.current = null
            driftSamplesRef.current = []
          }
        }
      } else {
        // VOD sync — compensate for stale server position by adding elapsed time since poll
        const clockOffset = useSyncStore.getState().clockOffset || 0
        const elapsed = pb.serverTs ? (Date.now() - pb.serverTs - clockOffset) / 1000 : 0
        const estimatedPos = pb.position + Math.max(0, Math.min(elapsed, 2)) // cap at 2s to avoid garbage
        const drift = estimatedPos - video.currentTime
        setDrift(`drift: ${drift.toFixed(1)}s`)
        send({ type: 'phone-state', drift: +drift.toFixed(2) })

        if (Math.abs(drift) > 2) {
          video.currentTime = estimatedPos
          video.playbackRate = 1.0
        } else if (Math.abs(drift) > 0.3) {
          // Adjust phone playback rate to close the gap
          // drift > 0 = phone behind → speed up phone; drift < 0 = phone ahead → slow down
          video.playbackRate = Math.max(0.9, Math.min(1.1, 1.0 + drift * 0.1))
        } else if (video.playbackRate !== 1.0) {
          video.playbackRate = 1.0
        }
      }
    }, 1000)

    return () => {
      clearInterval(interval)
      delete window._nudgeOffset
    }
  }, [phoneOpen, send])

  const handleClose = useCallback(() => {
    readyRef.current = false
    calibOffsetRef.current = null
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
