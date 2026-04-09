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
  const lastSeekRef = useRef(0) // timestamp of last live seek (cooldown)
  const driftDisplayRef = useRef(null)
  const offsetDisplayRef = useRef(null)
  const waitForVlcRef = useRef(null) // track waitForVlc interval for cleanup
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
          // Safari native: use proxy with direct YouTube segment URLs (no extra hop)
          // hls.js (Chrome): use proxy with proxied segments (CORS workaround)
          const useHls = data.isLive && Hls.isSupported()
          const url = data.isLive
            ? (useHls ? (data.proxyUrl || data.streamUrl) : `${data.proxyUrl || '/api/phone-hls'}?direct=1`)
            : data.streamUrl
          setStreamUrl(url)

          // Store VLC buffer delay for DVR reloads
          const vlcBufDelay = data.vlcBufferDelay || 19
          // Wait for VLC to start playing before loading phone video
          waitForVlcRef.current = setInterval(() => {
            const pb = usePlaybackStore.getState()
            if (!pb.playing || pb.paused) return
            clearInterval(waitForVlcRef.current)
            waitForVlcRef.current = null

            setTimeout(() => {
              const video = videoRef.current
              if (!video) return
              const fullUrl = url.startsWith('/') ? `${location.origin}${url}` : url
              video._vlcBufDelay = vlcBufDelay
              if (data.isLive && Hls.isSupported()) {
                if (video._hls) { video._hls.destroy(); video._hls = null }
                // Compute liveSyncDurationCount based on actual segment duration + VLC buffer
                const segDur = data.segDuration || 2
                const vlcBuf = data.vlcBufferDelay || 19
                const syncCount = Math.round(vlcBuf / segDur)
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
                  // Native Safari HLS: wait for seekable range, then seek to match VLC
                  const vlcBuf = data.vlcBufferDelay || 25
                  const waitSeekable = () => {
                    if (video.seekable?.length > 0) {
                      const seekableEnd = video.seekable.end(video.seekable.length - 1)
                      video.currentTime = Math.max(0, seekableEnd - vlcBuf)
                      video.play().then(() => { readyRef.current = true; readyAtRef.current = Date.now() }).catch(() => {})
                    } else {
                      // Retry until seekable is populated
                      setTimeout(waitSeekable, 500)
                    }
                  }
                  video.addEventListener('loadedmetadata', () => {
                    waitSeekable()
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

    return () => {
      if (waitForVlcRef.current) { clearInterval(waitForVlcRef.current); waitForVlcRef.current = null }
    }
  }, [phoneOpen, addToast])

  // Imperative sync loop — reads store directly, no subscriptions that cause re-renders
  useEffect(() => {
    if (!phoneOpen) return

    let lastRateSend = 0
    const setDrift = (text) => { const el = driftDisplayRef.current; if (el) el.textContent = text }

    window._nudgeOffset = (delta) => {
      const v = videoRef.current
      if (v) v.currentTime += delta
      userOffsetRef.current = +(userOffsetRef.current + delta).toFixed(1)
      const el = offsetDisplayRef.current
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

      // Detect video switch on desktop — reload phone stream with full state reset
      if (pb.url && video._syncUrl && video._syncUrl !== pb.url) {
        setDrift('video switched, reloading...')
        video._syncUrl = pb.url
        readyRef.current = false
        readyAtRef.current = 0
        lastSeekRef.current = 0
        calibOffsetRef.current = null
        driftSamplesRef.current = []
        userOffsetRef.current = 0
        const el = offsetDisplayRef.current
        if (el) el.textContent = '0.0s'
        // Re-fetch phone stream URL for new video
        fetch('/api/watch-on-phone', { method: 'POST' })
          .then(r => r.json())
          .then(data => {
            if (data.streamUrl) {
              const fullUrl = data.streamUrl.startsWith('/') ? `${location.origin}${data.streamUrl}` : data.streamUrl
              if (video._hls) { video._hls.destroy(); video._hls = null }
              video.src = fullUrl
              setTimeout(() => {
                const newPb = usePlaybackStore.getState()
                video.currentTime = newPb.position || data.seconds || 0
                video.play().then(() => { readyRef.current = true; readyAtRef.current = Date.now() }).catch(() => {})
              }, 2000)
            }
          }).catch(() => {})
        return
      }
      if (!video._syncUrl) video._syncUrl = pb.url

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

      if (pb.isLive && pb.player === 'mpv') {
        // mpv live: calibrated drift — both time-pos and phone currentTime advance at ~1s/s
        // but have different bases (mpv = absolute PTS, phone = relative)
        const rawDiff = pb.position - video.currentTime
        if (calibOffsetRef.current === null) {
          calibOffsetRef.current = rawDiff
          setDrift('calibrated (mpv live)')
          return
        }
        const drift = rawDiff - calibOffsetRef.current + userOffsetRef.current

        setDrift(`drift: ${drift.toFixed(2)}s`)
        send({ type: 'phone-state', drift: +drift.toFixed(2) })

        const now = Date.now()
        if (Math.abs(drift) > 5) {
          video.currentTime += drift
          calibOffsetRef.current = null
          driftSamplesRef.current = []
          lastSeekRef.current = now
        } else if (Math.abs(drift) > 0.5 && now - lastSeekRef.current > 5000) {
          video.currentTime += drift
          lastSeekRef.current = now
        }
      } else if (pb.isLive && pb.player === 'vlc') {
        // Detect DVR seeks by large position jumps
        const lastVlcPos = video._vlcLastPos || pb.position
        video._vlcLastPos = pb.position
        const posJump = Math.abs(pb.position - lastVlcPos)
        if (posJump > 10) {
          // VLC position jumped — DVR scrub detected, reload phone stream
          setDrift(`DVR jump: ${posJump.toFixed(0)}s, reloading...`)
          send({ type: 'phone-state', debug: `DVR jump=${posJump.toFixed(0)} old=${lastVlcPos.toFixed(0)} new=${pb.position.toFixed(0)}` })
          calibOffsetRef.current = null
          driftSamplesRef.current = []
          readyRef.current = false
          if (video._hls) {
            video._hls.stopLoad()
            video._hls.loadSource(`/api/phone-hls?_t=${Date.now()}`)
            video._hls.startLoad()
            setTimeout(() => { readyRef.current = true; readyAtRef.current = Date.now() }, 3000)
          } else {
            video.src = ''
            video.src = `/api/phone-hls?direct=1&_t=${Date.now()}`
            video.addEventListener('loadedmetadata', () => {
              if (video.seekable?.length > 0) {
                // DVR reload: use measured VLC buffer delay + 2s for rebuffer
                const pb2 = usePlaybackStore.getState()
                video.currentTime = video.seekable.end(video.seekable.length - 1) - (video._vlcBufDelay || 21)
              }
              video.play().then(() => { readyRef.current = true; readyAtRef.current = Date.now() }).catch(() => {})
            }, { once: true })
          }
          return
        }
        // PDT-based absolute time sync
        // Interpolate VLC time forward since last server update to avoid sawtooth
        const clockOffset = useSyncStore.getState().clockOffset || 0
        // clockOffset = serverClock - clientClock, so clientNow + clockOffset ≈ serverNow
        const elapsed = pb.serverTs ? Math.max(0, Math.min(Date.now() + clockOffset - pb.serverTs, 2000)) : 0
        const vlcAbsMs = pb.absoluteMs ? pb.absoluteMs + elapsed : null
        let phoneAbsMs = null

        // Note: getStartDate() is unstable on Safari live HLS — shifts as manifest
        // sliding window moves. Skip PDT path for live, use behind-live fallback only.

        if (vlcAbsMs && phoneAbsMs) {
          const rawOffset = vlcAbsMs - phoneAbsMs
          // Calibrate on first measurement — vlcPdtEpochMs has precision error so we
          // measure the baseline offset and track drift relative to it
          if (calibOffsetRef.current === null) {
            calibOffsetRef.current = rawOffset / 1000 // store in seconds
            setDrift('calibrated')
            return
          }
          const rawDrift = rawOffset / 1000 - calibOffsetRef.current + userOffsetRef.current
          if (Math.abs(rawDrift) > 300) return
          // Smooth with 5-sample moving average to filter seekable.end() jitter
          driftSamplesRef.current.push(rawDrift)
          if (driftSamplesRef.current.length > 5) driftSamplesRef.current.shift()
          const drift = driftSamplesRef.current.reduce((a, b) => a + b, 0) / driftSamplesRef.current.length

          setDrift(`drift: ${drift.toFixed(1)}s`)
          send({ type: 'phone-state', drift: +drift.toFixed(2) })

          // Live micro-seeks with 10s cooldown to avoid rebuffer spam
          const now = Date.now()
          if (Math.abs(drift) > 5) {
            video.currentTime += drift
            calibOffsetRef.current = null
            driftSamplesRef.current = []
            lastSeekRef.current = now
          } else if (Math.abs(drift) > 0.2 && now - lastSeekRef.current > 5000) {
            video.currentTime += drift
            lastSeekRef.current = now
          }
        } else {
          // Fallback: use vlcTime (smooth, interpolated) vs phone currentTime
          // Both advance at ~1s/s, difference should be stable
          // Smooth drift: vlcTime vs currentTime (both advance linearly at ~1s/s)
          // Initial position was set correctly by seekableEnd - vlcBuf
          const vlcT = pb.vlcTime || 0
          const rawDiff = vlcT - video.currentTime
          if (calibOffsetRef.current === null) {
            calibOffsetRef.current = rawDiff
            setDrift('calibrated')
            return
          }
          const drift = rawDiff - calibOffsetRef.current + userOffsetRef.current

          setDrift(`drift: ${drift.toFixed(2)}s`)
          send({ type: 'phone-state', drift: +drift.toFixed(2) })

          const now2 = Date.now()
          if (Math.abs(drift) > 5) {
            video.currentTime += drift
            calibOffsetRef.current = null
            lastSeekRef.current = now2
          } else if (Math.abs(drift) > 0.5 && now2 - lastSeekRef.current > 10000) {
            video.currentTime += drift
            lastSeekRef.current = now2
          }
        }
      } else {
        // VOD sync — interpolate mpv position to compensate for 1s WS staleness
        const clockOffset = useSyncStore.getState().clockOffset || 0
        const elapsed = pb.serverTs ? Math.max(0, Math.min(Date.now() + clockOffset - pb.serverTs, 2000)) / 1000 : 0
        const mpvPos = pb.position + elapsed
        const rawDiff = mpvPos - video.currentTime

        const drift = rawDiff + userOffsetRef.current
        setDrift(`drift: ${drift.toFixed(1)}s`)
        send({ type: 'phone-state', drift: +drift.toFixed(2) })

        // Hard-seek: immediate first correction, then 5s cooldown for HLS stability
        const now3 = Date.now()
        const cooldown = lastSeekRef.current === 0 ? 0 : 5000
        if (Math.abs(drift) > 0.2 && now3 - lastSeekRef.current > cooldown) {
          video.currentTime = mpvPos + 0.5
          lastSeekRef.current = now3
        }
      }
    }, 1000)

    return () => {
      delete window._nudgeOffset
      clearInterval(interval)
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
      if (videoRef.current._hls) { videoRef.current._hls.destroy(); videoRef.current._hls = null }
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
        style={{ width: '100%', maxHeight: '30vh', display: 'block', background: 'var(--bg)' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', background: 'var(--surface)', fontSize: '12px', fontFamily: 'monospace' }}>
        <span ref={driftDisplayRef} style={{ color: 'var(--green)' }}>drift: --</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button onClick={() => window._nudgeOffset?.(-5)} style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)', fontSize: '10px' }}>-5</button>
          <button onClick={() => window._nudgeOffset?.(-0.5)} style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)', fontSize: '10px' }}>-0.5</button>
          <span ref={offsetDisplayRef} style={{ color: 'var(--yellow)', minWidth: '60px', textAlign: 'center' }}>0.0s</span>
          <button onClick={() => window._nudgeOffset?.(0.5)} style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)', fontSize: '10px' }}>+0.5</button>
          <button onClick={() => window._nudgeOffset?.(5)} style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)', fontSize: '10px' }}>+5</button>
        </div>
        <button onClick={handleClose} style={{ padding: '6px 12px', background: 'var(--surface-hover)', color: 'var(--red)', border: '1px solid var(--text-dim)' }}>CLOSE</button>
      </div>
    </div>
  )
}
