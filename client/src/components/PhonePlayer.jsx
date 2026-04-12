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
  const nudgeRef = useRef(null)
  const hlsRef = useRef(null)
  const syncUrlRef = useRef(null)
  const vlcLastPosRef = useRef(null)
  const vlcBufDelayRef = useRef(21)
  const [streamUrl, setStreamUrl] = useState(null)
  const [isLive, setIsLive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [compMode, setCompMode] = useState(false)
  const compModeRef = useRef(false)
  const resumePosRef = useRef(0)
  const hlsOffsetRef = useRef(0)
  const bgAudioRef = useRef(null)

  const phoneOpen = useSyncStore(s => s.phoneOpen)
  const phoneOnlyUrl = useSyncStore(s => s.phoneOnlyUrl)
  const setPhoneOpen = useSyncStore(s => s.setPhoneOpen)
  const addToast = useUIStore(s => s.addToast)
  const phoneOnlyRef = useRef(false)

  // Fetch stream URL on open — skip if already loaded (just resuming from hide)
  useEffect(() => {
    if (!phoneOpen) return
    if (streamUrl && videoRef.current && videoRef.current.src) {
      // Already loaded — just resume
      videoRef.current.play().catch(() => {})
      // Re-mute+pause mpv
      fetch('/api/phone-only-resume', { method: 'POST' }).catch(() => {})
      return
    }
    setLoading(true)
    phoneOnlyRef.current = !!phoneOnlyUrl

    const fetchUrl = phoneOnlyUrl
      ? fetch('/api/phone-only', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: phoneOnlyUrl }) })
      : fetch('/api/watch-on-phone', { method: 'POST' })

    fetchUrl
      .then(r => r.json())
      .then(data => {
        if (data.streamUrl) {
          setIsLive(!!data.isLive)
          // Phone-only: always use direct stream URL. Sync mode: use proxy for HLS on iOS
          const useHls = data.isLive && Hls.isSupported()
          const url = phoneOnlyRef.current
            ? data.streamUrl
            : (data.isLive
                ? (useHls ? (data.proxyUrl || data.streamUrl) : `${data.proxyUrl || '/api/phone-hls'}?direct=1`)
                : data.streamUrl)
          setStreamUrl(url)

          const vlcBufDelay = data.vlcBufferDelay || 19

          // Phone-only: load immediately, no mpv sync
          if (phoneOnlyRef.current) {
            resumePosRef.current = data.seconds || 0
            const hlsOffset = data.hlsSeekOffset || 0
            hlsOffsetRef.current = hlsOffset
            readyRef.current = true
            readyAtRef.current = Date.now()
            setLoading(false)

            // For live: explicitly load via JS (same as sync mode) — iOS needs this
            if (data.isLive) {
              setTimeout(() => {
                const v = videoRef.current
                if (!v) return
                const fullUrl = url.startsWith('/') ? `${location.origin}${url}` : url
                v.src = fullUrl
                v.addEventListener('loadedmetadata', () => {
                  // Seek to live edge minus 25s for buffer
                  if (v.seekable?.length > 0) {
                    const end = v.seekable.end(v.seekable.length - 1)
                    v.currentTime = Math.max(0, end - 25)
                  }
                  v.play().catch(() => {})
                }, { once: true })
              }, 200)
            }

            // Background audio: use same URL as video (iOS Safari Audio plays HLS natively)
            const bgUrl = url.startsWith('/') ? `${location.origin}${url}` : url
            const bgAudio = new Audio(bgUrl)
            bgAudio.preload = 'auto'
            bgAudio.load()
            bgAudioRef.current = bgAudio

            let bgMode = false

            // Wire up play/pause/seek controls for now-playing bar — controls phone + mpv together
            useSyncStore.getState().setPhoneVideoCtrl({
              play: () => {
                if (bgMode) { bgAudio.play().catch(() => {}) } else { videoRef.current?.play() }
                fetch('/api/playpause', { method: 'POST' }).catch(() => {}) // unpause mpv
              },
              pause: () => {
                bgAudio.pause(); videoRef.current?.pause()
                fetch('/api/playpause', { method: 'POST' }).catch(() => {}) // pause mpv
              },
              seek: (t) => { if (videoRef.current) videoRef.current.currentTime = t; bgAudio.currentTime = t },
            })

            // On background: start bgAudio (or silent in comp mode), mute video.
            const handleVisibility = () => {
              const v = videoRef.current
              if (!v) return
              if (document.visibilityState === 'hidden') {
                if (compModeRef.current) {
                  // In comp mode — just keep silent audio for media session, don't play bgAudio
                  const silentAudio = useSyncStore.getState().silentAudioRef
                  if (silentAudio) silentAudio.play().catch(() => {})
                  return
                }
                bgMode = true
                bgAudio.currentTime = v.currentTime
                bgAudio.volume = 1
                bgAudio.play().catch(() => {})
                v.muted = true
                v.pause()
                const silentAudio = useSyncStore.getState().silentAudioRef
                if (silentAudio) silentAudio.pause()
                if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
                usePlaybackStore.getState().update({ paused: false })
              } else {
                if (compModeRef.current) return // Stay paused in comp mode
                bgMode = false
                const resumeAt = bgAudio.currentTime
                bgAudio.pause()
                // Only sync position if bgAudio actually played (advanced beyond where we set it)
                if (resumeAt > 1 && Math.abs(resumeAt - v.currentTime) > 2) v.currentTime = resumeAt
                v.muted = false
                v.play().catch(() => {})
                const silentAudio = useSyncStore.getState().silentAudioRef
                if (silentAudio) silentAudio.play().catch(() => {})
              }
            }
            document.addEventListener('visibilitychange', handleVisibility)

            useSyncStore.getState().setPhoneVideoCtrl({
              play: () => { if (bgMode) { bgAudio.play().catch(() => {}) } else { videoRef.current?.play() } },
              pause: () => { bgAudio.pause(); videoRef.current?.pause() },
              seek: (t) => { if (videoRef.current) videoRef.current.currentTime = t; bgAudio.currentTime = t },
            })

            const origCleanup = () => {
              document.removeEventListener('visibilitychange', handleVisibility)
              bgAudio.pause()
              bgAudio.removeAttribute('src')
              bgAudio.load()
              useSyncStore.getState().setPhoneVideoCtrl(null)
            }
            // Store cleanup ref for the effect's return
            waitForVlcRef.current = { clear: origCleanup }
            return
          }

          // Normal mode: wait for mpv to be playing before loading phone video
          waitForVlcRef.current = setInterval(() => {
            const pb = usePlaybackStore.getState()
            if (!pb.playing || pb.paused) return
            clearInterval(waitForVlcRef.current)
            waitForVlcRef.current = null

            setTimeout(() => {
              const video = videoRef.current
              if (!video) return
              const fullUrl = url.startsWith('/') ? `${location.origin}${url}` : url
              vlcBufDelayRef.current = vlcBufDelay
              if (data.isLive && Hls.isSupported()) {
                if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
                const segDur = data.segDuration || 2
                const pb = usePlaybackStore.getState()
                const syncCount = pb.player === 'mpv' ? 4 : Math.round((data.vlcBufferDelay || 19) / segDur)
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
                hlsRef.current = hls
              } else {
                video.src = fullUrl
                if (data.isLive) {
                  const vlcBuf = data.vlcBufferDelay || 25
                  const waitSeekable = () => {
                    if (video.seekable?.length > 0) {
                      const seekableEnd = video.seekable.end(video.seekable.length - 1)
                      video.currentTime = Math.max(0, seekableEnd - vlcBuf)
                      video.play().then(() => { readyRef.current = true; readyAtRef.current = Date.now() }).catch(() => {})
                    } else {
                      setTimeout(waitSeekable, 500)
                    }
                  }
                  video.addEventListener('loadedmetadata', () => { waitSeekable() }, { once: true })
                } else {
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
      if (waitForVlcRef.current?.clear) { waitForVlcRef.current.clear() }
      else if (waitForVlcRef.current) { clearInterval(waitForVlcRef.current) }
      waitForVlcRef.current = null
    }
  }, [phoneOpen, addToast])

  // Imperative sync loop — reads store directly, no subscriptions that cause re-renders
  useEffect(() => {
    if (!phoneOpen) return

    let lastRateSend = 0
    const setDrift = (text) => { const el = driftDisplayRef.current; if (el) el.textContent = text }

    nudgeRef.current = (delta) => {
      const v = videoRef.current
      if (!v) return
      v.currentTime += delta
      lastSeekRef.current = Date.now()
      userOffsetRef.current = +(userOffsetRef.current + delta).toFixed(1)
      const el = offsetDisplayRef.current
      if (el) el.textContent = `offset: ${userOffsetRef.current.toFixed(1)}s`
    }

    let tick = 0
    const interval = setInterval(() => {
      tick++
      const video = videoRef.current
      if (!video || !readyRef.current) return

      // Phone-only mode: no mpv sync, just keep playing
      if (phoneOnlyRef.current) {
        setDrift(`phone-only t${tick} ct:${video.currentTime?.toFixed(0)||'?'}`)
        return
      }

      const pb = usePlaybackStore.getState()
      // Always show debug status
      setDrift(`t${tick} v:${!!video} ct:${video?.currentTime?.toFixed(0)||'?'} p:${pb.playing} l:${pb.isLive} h:${!!hlsRef.current}`)

      // Detect video switch on desktop — reload phone stream with full state reset
      if (pb.url && syncUrlRef.current && syncUrlRef.current !== pb.url) {
        setDrift('video switched, reloading...')
        syncUrlRef.current = pb.url
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
              if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
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
      if (!syncUrlRef.current) syncUrlRef.current = pb.url

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
        // -1s compensates mpv HLS audio pipeline latency (time-pos leads actual playback)
        const rawDiff = pb.position - video.currentTime
        if (calibOffsetRef.current === null) {
          calibOffsetRef.current = rawDiff
          // mpv time-pos leads actual audio — seek phone back
          video.currentTime -= 0.5
          calibOffsetRef.current = pb.position - video.currentTime
          setDrift('calibrated (mpv live)')
          return
        }
        const drift = rawDiff - calibOffsetRef.current

        setDrift(`drift: ${drift.toFixed(2)}s`)
        send({ type: 'phone-state', drift: +drift.toFixed(2) })

        const now = Date.now()
        if (Math.abs(drift) > 5) {
          video.currentTime += drift
          calibOffsetRef.current = null
          lastSeekRef.current = now
        } else if (Math.abs(drift) > 2 && now - lastSeekRef.current > 10000) {
          video.currentTime += drift
          lastSeekRef.current = now
        }
      } else if (pb.isLive && pb.player === 'vlc') {
        // Detect DVR seeks by large position jumps
        const lastVlcPos = vlcLastPosRef.current || pb.position
        vlcLastPosRef.current = pb.position
        const posJump = Math.abs(pb.position - lastVlcPos)
        if (posJump > 10) {
          // VLC position jumped — DVR scrub detected, reload phone stream
          setDrift(`DVR jump: ${posJump.toFixed(0)}s, reloading...`)
          send({ type: 'phone-state', debug: `DVR jump=${posJump.toFixed(0)} old=${lastVlcPos.toFixed(0)} new=${pb.position.toFixed(0)}` })
          calibOffsetRef.current = null
          driftSamplesRef.current = []
          readyRef.current = false
          if (hlsRef.current) {
            hlsRef.current.stopLoad()
            hlsRef.current.loadSource(`/api/phone-hls?_t=${Date.now()}`)
            hlsRef.current.startLoad()
            setTimeout(() => { readyRef.current = true; readyAtRef.current = Date.now() }, 3000)
          } else {
            video.src = ''
            video.src = `/api/phone-hls?direct=1&_t=${Date.now()}`
            video.addEventListener('loadedmetadata', () => {
              if (video.seekable?.length > 0) {
                // DVR reload: use measured VLC buffer delay + 2s for rebuffer
                const pb2 = usePlaybackStore.getState()
                video.currentTime = video.seekable.end(video.seekable.length - 1) - (vlcBufDelayRef.current || 21)
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
      nudgeRef.current = null
      clearInterval(interval)
    }
  }, [phoneOpen, send])

  const handleComp = useCallback(() => {
    // Switch to computer — pause phone + bgAudio, fade out, resume mpv
    if (videoRef.current) videoRef.current.pause()
    if (bgAudioRef.current) bgAudioRef.current.pause()
    const silentAudio = useSyncStore.getState().silentAudioRef
    if (silentAudio) silentAudio.pause()
    fetch('/api/stop-phone-stream', { method: 'POST' }).catch(() => {})
    // Clear phoneVideoCtrl so now-playing bar controls mpv directly
    useSyncStore.getState().setPhoneVideoCtrl(null)
    compModeRef.current = true
    setCompMode(true)
  }, [])

  const handlePhone = useCallback(() => {
    // Switch back to phone — seek phone to mpv's position, resume, mute+pause mpv
    const pb = usePlaybackStore.getState()
    if (videoRef.current && pb.position > 0) {
      videoRef.current.currentTime = pb.position
    }
    if (videoRef.current) videoRef.current.play().catch(() => {})
    // Restore phoneVideoCtrl so now-playing bar controls phone
    useSyncStore.getState().setPhoneVideoCtrl({
      play: () => { videoRef.current?.play(); fetch('/api/playpause', { method: 'POST' }).catch(() => {}) },
      pause: () => { videoRef.current?.pause(); fetch('/api/playpause', { method: 'POST' }).catch(() => {}) },
      seek: (t) => { if (videoRef.current) videoRef.current.currentTime = t },
    })
    fetch('/api/phone-only-resume', { method: 'POST' }).catch(() => {})
    compModeRef.current = false
    setCompMode(false)
  }, [])

  const handleClose = useCallback(() => {
    setCompMode(false)
    const phonePos = videoRef.current?.currentTime || 0
    if (videoRef.current) videoRef.current.pause()
    fetch('/api/stop-phone-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: phonePos }),
    }).catch(() => {})
    send({ type: 'mpv-speed', speed: 1.0 })
    setPhoneOpen(false)
  }, [setPhoneOpen, send])

  if (!phoneOpen && !streamUrl) return null

  return (
    <div className="phone-player" style={{
      ...((!phoneOpen && !streamUrl) ? { display: 'none' } : {}),
      ...(compMode ? { transform: 'translateY(calc(-100% + 30px))', opacity: 0.4, transition: 'transform 0.3s, opacity 0.3s' } : { transform: 'translateY(0)', transition: 'transform 0.3s, opacity 0.3s' }),
    }}>
      <video
        ref={(el) => {
          videoRef.current = el
          if (el && phoneOnlyUrl) el.autoPictureInPicture = true
        }}
        src={phoneOnlyUrl && streamUrl ? streamUrl : undefined}
        playsInline
        autoPlay
        muted
        controls
        onLoadedMetadata={() => {
          if (phoneOnlyUrl && videoRef.current && resumePosRef.current > 0) {
            videoRef.current.currentTime = resumePosRef.current
            resumePosRef.current = 0
          }
        }}
        onPlay={() => {
          if (phoneOnlyUrl && videoRef.current) {
            videoRef.current.muted = false
            // Unlock bgAudio from user gesture chain so it can play on background
            if (bgAudioRef.current && bgAudioRef.current.paused) {
              bgAudioRef.current.volume = 0.01
              bgAudioRef.current.play().then(() => bgAudioRef.current.pause()).catch(() => {})
            }
          }
        }}
        style={{ width: '100%', maxHeight: '30vh', display: 'block', background: 'var(--bg)' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', background: 'var(--surface)', fontSize: '12px', fontFamily: 'monospace' }}>
        <span ref={driftDisplayRef} style={{ color: 'var(--green)' }}>drift: --</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button onClick={() => nudgeRef.current?.(-5)} style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)', fontSize: '10px' }}>-5</button>
          <button onClick={() => nudgeRef.current?.(-1)} style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)', fontSize: '10px' }}>-1</button>
          <span ref={offsetDisplayRef} style={{ color: 'var(--yellow)', minWidth: '60px', textAlign: 'center' }}>0.0s</span>
          <button onClick={() => nudgeRef.current?.(1)} style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)', fontSize: '10px' }}>+1</button>
          <button onClick={() => nudgeRef.current?.(5)} style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)', fontSize: '10px' }}>+5</button>
        </div>
        {phoneOnlyUrl && <button onClick={compMode ? handlePhone : handleComp} style={{ padding: '6px 12px', background: 'var(--surface-hover)', color: compMode ? 'var(--green)' : 'var(--text)', border: '1px solid var(--text-dim)' }}>{compMode ? 'PHONE' : 'COMP'}</button>}
        <button onClick={handleClose} style={{ padding: '6px 12px', background: 'var(--surface-hover)', color: 'var(--red)', border: '1px solid var(--text-dim)' }}>CLOSE</button>
      </div>
    </div>
  )
}
