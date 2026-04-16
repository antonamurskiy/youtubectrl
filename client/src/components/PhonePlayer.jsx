import { useState, useRef, useEffect, useCallback } from 'react'
import Hls from 'hls.js'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import { useUIStore } from '../stores/ui'
import { isNativeIOS, NativePlayer } from '../native/player'
import { tick as hapticTick, thump as hapticThump } from '../haptics'

// Native AVPlayer position cache — polled on a separate interval so the
// sync loop can read it without awaiting every tick.
let _nativePos = 0
let _nativePosAt = 0
function nativePosNow() {
  const elapsed = (Date.now() - _nativePosAt) / 1000
  return _nativePos + elapsed
}


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
  const [mini, setMini] = useState(() => {
    try { return localStorage.getItem('phone-mini') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('phone-mini', mini ? '1' : '0') } catch {}
  }, [mini])
  const [miniPos, setMiniPos] = useState(() => {
    try { const v = localStorage.getItem('phone-mini-pos'); return v ? JSON.parse(v) : null } catch { return null }
  })
  const [miniWidth, setMiniWidth] = useState(() => {
    try { const v = parseInt(localStorage.getItem('phone-mini-width'), 10); return Number.isFinite(v) && v >= 140 ? v : 260 } catch { return 260 }
  })
  useEffect(() => {
    try {
      if (miniPos) localStorage.setItem('phone-mini-pos', JSON.stringify(miniPos))
      else localStorage.removeItem('phone-mini-pos')
    } catch {}
  }, [miniPos])
  useEffect(() => {
    try { localStorage.setItem('phone-mini-width', String(miniWidth)) } catch {}
  }, [miniWidth])
  const dragRef = useRef(null)
  const resizeRef = useRef(null)
  const compModeRef = useRef(false)
  const resumePosRef = useRef(0)
  const bgAudioRef = useRef(null)
  const loadedUrlRef = useRef(null) // last fetched phone-only URL, to detect video changes

  const phoneOpen = useSyncStore(s => s.phoneOpen)
  const phoneOnlyUrl = useSyncStore(s => s.phoneOnlyUrl)
  const setPhoneOpen = useSyncStore(s => s.setPhoneOpen)
  const addToast = useUIStore(s => s.addToast)
  const phoneOnlyRef = useRef(false)

  // Fetch stream URL on open — skip ONLY if the same video is already loaded
  useEffect(() => {
    if (!phoneOpen) return
    // If the currently-loaded video matches what the user wants, just resume
    if (streamUrl && videoRef.current?.src && loadedUrlRef.current === phoneOnlyUrl) {
      videoRef.current.play().catch(() => {})
      fetch('/api/phone-only-resume', { method: 'POST' }).catch(() => {})
      return
    }
    setLoading(true)
    phoneOnlyRef.current = !!phoneOnlyUrl
    // Clear loadedUrlRef until the fetch actually succeeds — otherwise an aborted/failed
    // fetch leaves the ref pointing at a URL we never loaded, and the "already loaded"
    // fast path above will falsely skip refetching on the next tap.
    loadedUrlRef.current = null

    // AbortController so a newer video change cancels the in-flight fetch
    const abortCtrl = new AbortController()
    const fetchUrl = phoneOnlyUrl
      ? fetch('/api/phone-only', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: phoneOnlyUrl }), signal: abortCtrl.signal })
      : fetch('/api/watch-on-phone', { method: 'POST', signal: abortCtrl.signal })

    fetchUrl
      .then(r => r.json())
      .then(data => {
        // Guard against stale responses after the effect was cleaned up
        if (abortCtrl.signal.aborted) return
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
          loadedUrlRef.current = phoneOnlyUrl
          // Native iOS: hand off to AVPlayer for PiP + lock-screen controls + bg audio.
          // We still render the <video> below for the visible preview, but muted; AVPlayer
          // is the source of truth for audio and supports real system PiP.
          if (isNativeIOS && NativePlayer.available) {
            const absUrl = url.startsWith('/') ? `${location.origin}${url}` : url
            // If the server returned separate DASH video + audio URLs, pass
            // them through. AVPlayer combines them natively for 1080p + AAC
            // with no remuxing.
            const videoUrl = data.videoUrl || undefined
            const audioUrl = data.audioUrl || undefined
            NativePlayer.load({
              url: absUrl,
              videoUrl,
              audioUrl,
              position: data.seconds || 0,
              autoplay: true,
              // Sync mode: mpv is the audio source, phone must be muted to
              // avoid a doubled audio track.
              muted: !phoneOnlyRef.current,
            }).catch(() => {})
          }

          const vlcBufDelay = data.vlcBufferDelay || 19

          // Phone-only: load immediately, no mpv sync
          if (phoneOnlyRef.current) {
            resumePosRef.current = data.seconds || 0
            readyRef.current = true
            readyAtRef.current = Date.now()
            setLoading(false)

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
              // Skip delta — reads the phone video's live currentTime instead of mpv's
              // (pb.position) which drifts in phone-only mode.
              skip: (delta) => {
                const v = videoRef.current
                if (!v) return
                v.currentTime = Math.max(0, (v.currentTime || 0) + delta)
                bgAudio.currentTime = v.currentTime
              },
            })

            // On background: start bgAudio (or silent in comp mode), mute video.
            // On native iOS the AVPlayer already plays in the background without any of
            // this web-only trickery, so the handler is a no-op there.
            const handleVisibility = () => {
              if (isNativeIOS) return
              const v = videoRef.current
              if (!v) return
              if (document.visibilityState === 'hidden') {
                if (compModeRef.current) {
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
                if (compModeRef.current) return
                bgMode = false
                const resumeAt = bgAudio.currentTime
                bgAudio.pause()
                if (resumeAt > 1 && Math.abs(resumeAt - v.currentTime) > 2) v.currentTime = resumeAt
                v.muted = false
                v.play().catch(() => {})
                const silentAudio = useSyncStore.getState().silentAudioRef
                if (silentAudio) silentAudio.play().catch(() => {})
              }
            }
            document.addEventListener('visibilitychange', handleVisibility)

            // Track our own paused state for phone-only mode since mpv's
            // pb.paused doesn't apply here.
            let ctrlPaused = false
            useSyncStore.getState().setPhoneVideoCtrl({
              play: () => {
                ctrlPaused = false
                if (isNativeIOS) NativePlayer.play().catch(() => {})
                if (bgMode) { bgAudio.play().catch(() => {}) } else { videoRef.current?.play() }
                usePlaybackStore.getState().update({ paused: false })
              },
              pause: () => {
                ctrlPaused = true
                if (isNativeIOS) NativePlayer.pause().catch(() => {})
                bgAudio.pause(); videoRef.current?.pause()
                usePlaybackStore.getState().update({ paused: true })
              },
              seek: (t) => {
                if (isNativeIOS) NativePlayer.seek(t).catch(() => {})
                if (videoRef.current) videoRef.current.currentTime = t
                bgAudio.currentTime = t
              },
              skip: (delta) => {
                const v = videoRef.current
                if (!v) return
                const newT = Math.max(0, (v.currentTime || 0) + delta)
                if (isNativeIOS) NativePlayer.seek(newT).catch(() => {})
                v.currentTime = newT
                bgAudio.currentTime = newT
              },
              isPaused: () => ctrlPaused,
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
      .catch((err) => {
        if (err?.name === 'AbortError') return // superseded by newer request
        addToast('Failed to get stream')
        setLoading(false)
      })

    return () => {
      abortCtrl.abort()
      if (waitForVlcRef.current?.clear) { waitForVlcRef.current.clear() }
      else if (waitForVlcRef.current) { clearInterval(waitForVlcRef.current) }
      waitForVlcRef.current = null
    }
  }, [phoneOpen, phoneOnlyUrl, addToast])

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
        const phonePos = isNativeIOS ? nativePosNow() : (video.currentTime || 0)
        const rawDiff = mpvPos - phonePos + userOffsetRef.current

        // Smooth across 5 samples to filter WS tick jitter — mpv's
        // time-pos arrives with ~50-150ms variance from network.
        driftSamplesRef.current.push(rawDiff)
        if (driftSamplesRef.current.length > 5) driftSamplesRef.current.shift()
        const drift = driftSamplesRef.current.reduce((a, b) => a + b, 0) / driftSamplesRef.current.length

        setDrift(`drift: ${drift.toFixed(2)}s`)
        send({ type: 'phone-state', drift: +drift.toFixed(2), mpv: +mpvPos.toFixed(2), phone: +phonePos.toFixed(2) })

        const now3 = Date.now()
        const cooldown = lastSeekRef.current === 0 ? 0 : 2500

        // Only hard-seek if drift is SERIOUSLY off — sub-second drift
        // is handled by rate nudging to avoid the overshoot loop that
        // happens with aggressive seeks.
        if (Math.abs(drift) > 1.0 && now3 - lastSeekRef.current > cooldown) {
          const target = mpvPos + (isNativeIOS ? 0 : 0.2)
          if (isNativeIOS) {
            NativePlayer.seek(target).catch(() => {})
            _nativePos = target
            _nativePosAt = Date.now()
          } else {
            video.currentTime = target
          }
          lastSeekRef.current = now3
          driftSamplesRef.current = [] // reset smoother after seek
          send({ type: 'mpv-speed', speed: 1.0 })
          lastRateSend = 0
        } else if (Math.abs(drift) > 0.05) {
          // Sub-second drift: nudge mpv rate. Dead zone 50ms prevents the
          // oscillation loop. Proportional response scales to drift.
          const rate = Math.max(0.9, Math.min(1.1, 1.0 - drift * 0.5))
          if (now3 - lastRateSend > 500) {
            send({ type: 'mpv-speed', speed: +rate.toFixed(4) })
            lastRateSend = now3
          }
        } else if (lastRateSend > 0) {
          send({ type: 'mpv-speed', speed: 1.0 })
          lastRateSend = 0
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
    setMini(true)
    hapticThump()
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
    setMini(false)
    hapticThump()
  }, [])

  // Sync phone playhead position to the hidden mpv so its own progress
  // tracking picks up the right number after we close.
  const syncToMpv = useCallback(async () => {
    const url = phoneOnlyUrl
    if (!url) return
    let position = 0
    if (isNativeIOS) {
      try { const s = await NativePlayer.getState(); position = s?.position || 0 } catch {}
    } else if (videoRef.current) {
      position = videoRef.current.currentTime || 0
    }
    if (position > 0) {
      fetch('/api/seek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position }),
      }).catch(() => {})
    }
  }, [phoneOnlyUrl])

  const handleClose = useCallback(() => {
    hapticThump()
    setCompMode(false)
    // Seek hidden mpv to wherever AVPlayer is, so its progress tracking
    // saves the right number.
    syncToMpv().finally(() => {
      if (videoRef.current) videoRef.current.pause()
      if (isNativeIOS) NativePlayer.stop().catch(() => {})
      fetch('/api/stop-phone-stream', { method: 'POST' }).catch(() => {})
      send({ type: 'mpv-speed', speed: 1.0 })
      setPhoneOpen(false)
      setStreamUrl(null)
      loadedUrlRef.current = null
    })
  }, [setPhoneOpen, send, syncToMpv])

  // Periodic sync every 10s so mpv's position tracker (which saves to
  // history) matches the phone player. Cheap: hits /api/seek which just
  // calls mpv's IPC.
  useEffect(() => {
    if (!phoneOnlyUrl) return
    const iv = setInterval(() => { syncToMpv() }, 10000)
    return () => clearInterval(iv)
  }, [phoneOnlyUrl, syncToMpv])

  // Poll native AVPlayer's position into the nativePosNow() cache so the
  // sync loop can compute drift against it without awaiting every tick.
  useEffect(() => {
    if (!isNativeIOS || !phoneOpen) return
    let alive = true
    const tick = async () => {
      if (!alive) return
      try {
        const s = await NativePlayer.getState()
        if (s && typeof s.position === 'number') {
          _nativePos = s.position
          _nativePosAt = Date.now()
        }
      } catch {}
      if (alive) setTimeout(tick, 250)
    }
    tick()
    return () => { alive = false }
  }, [phoneOpen])

  // On native iOS in phone-only mode, poll the AVPlayer's state and push
  // it into the playback store so the NowPlayingBar (which reads mpv's
  // WebSocket broadcast in sync mode) has live data to render.
  useEffect(() => {
    if (!isNativeIOS || !phoneOnlyUrl) return
    let alive = true
    const tick = async () => {
      if (!alive) return
      try {
        const s = await NativePlayer.getState()
        if (s && alive) {
          usePlaybackStore.getState().update({
            position: Number.isFinite(s.position) ? s.position : 0,
            duration: Number.isFinite(s.duration) ? s.duration : 0,
            paused: !!s.paused,
          })
        }
      } catch {}
      if (alive) setTimeout(tick, 500)
    }
    tick()
    return () => { alive = false }
  }, [phoneOnlyUrl])

  // On native iOS: sync the native AVPlayer layer position to match the
  // <video> element's rect on every frame, so the AVPlayer is what the
  // user sees inline. HTML video stays transparent/empty but preserves
  // layout + touch handlers (drag, tap-to-expand).
  useEffect(() => {
    if (!isNativeIOS) return
    let alive = true
    let lastKey = ''
    const tick = () => {
      if (!alive) return
      const el = videoRef.current
      if (el && phoneOpen && streamUrl) {
        const r = el.getBoundingClientRect()
        const visible = r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < window.innerHeight
        const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)},${visible}`
        if (key !== lastKey) {
          lastKey = key
          NativePlayer.setLayerFrame({
            x: Math.round(r.left),
            y: Math.round(r.top),
            w: Math.round(r.width),
            h: Math.round(r.height),
            visible,
          }).catch(() => {})
        }
      } else if (lastKey !== 'hidden') {
        lastKey = 'hidden'
        NativePlayer.setLayerFrame({ x: 0, y: 0, w: 1, h: 1, visible: false }).catch(() => {})
      }
      requestAnimationFrame(tick)
    }
    const id = requestAnimationFrame(tick)
    return () => { alive = false; cancelAnimationFrame(id) }
  }, [phoneOpen, streamUrl])

  if (!phoneOpen) return null

  return (
    <div className="phone-player" style={{
      ...((!phoneOpen && !streamUrl) ? { display: 'none' } : {}),
      ...(mini ? {
        position: 'fixed',
        ...(miniPos
          ? { left: `${miniPos.x}px`, top: `${miniPos.y}px`, right: 'auto', bottom: 'auto' }
          : { bottom: 'calc(env(safe-area-inset-bottom, 0px) + 120px)', right: '8px', left: 'auto', top: 'auto' }),
        width: `${miniWidth}px`,
        zIndex: 200,
        boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
        touchAction: 'none',
      } : { transform: 'translateY(0)', transition: 'transform 0.3s, opacity 0.3s' }),
    }}>
      <video
        ref={(el) => {
          videoRef.current = el
          // Native AVPlayer handles PiP; don't let the HTML video also try.
          if (el && phoneOnlyUrl && !isNativeIOS) el.autoPictureInPicture = true
        }}
        src={isNativeIOS ? undefined : (phoneOnlyUrl && streamUrl ? streamUrl : undefined)}
        playsInline
        autoPlay
        muted={
          // Sync mode (no phoneOnlyUrl): desktop mpv is the audio source,
          // phone video stays muted.
          // Phone-only on native: AVPlayer is the audio source, HTML muted.
          // Phone-only web: unmuted (phone is the audio source).
          isNativeIOS || !phoneOnlyUrl
        }
        controls={!mini && !isNativeIOS}
        onPointerDown={(e) => {
          if (!mini) return
          e.preventDefault()
          const el = e.currentTarget.parentElement
          const rect = el.getBoundingClientRect()
          dragRef.current = {
            dx: e.clientX - rect.left,
            dy: e.clientY - rect.top,
            w: rect.width,
            h: rect.height,
            moved: false,
            startX: e.clientX,
            startY: e.clientY,
            pointerId: e.pointerId,
          }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = dragRef.current
          if (!d || d.pointerId !== e.pointerId) return
          const dist = Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY)
          if (dist > 4 && !d.moved) { d.moved = true; hapticTick() }
          if (!d.moved) return
          const x = Math.max(4, Math.min(window.innerWidth - d.w - 4, e.clientX - d.dx))
          const y = Math.max(4, Math.min(window.innerHeight - d.h - 4, e.clientY - d.dy))
          setMiniPos({ x, y })
        }}
        onPointerUp={(e) => {
          const d = dragRef.current
          if (!d || d.pointerId !== e.pointerId) return
          const wasMoved = d.moved
          dragRef.current = null
          try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
          if (!wasMoved && mini) {
            // Block the synthetic click that follows this pointer sequence —
            // expanding removes the video from under the pointer, so the click
            // would otherwise land on the video card below.
            const suppress = (ev) => {
              ev.stopPropagation()
              ev.preventDefault()
              window.removeEventListener('click', suppress, true)
            }
            window.addEventListener('click', suppress, true)
            setTimeout(() => window.removeEventListener('click', suppress, true), 400)
            hapticThump()
            setMini(false)
          }
        }}
        onLoadedMetadata={() => {
          if (phoneOnlyUrl && videoRef.current && resumePosRef.current > 0) {
            videoRef.current.currentTime = resumePosRef.current
            resumePosRef.current = 0
          }
        }}
        onPlay={() => {
          if (phoneOnlyUrl && videoRef.current && !isNativeIOS) {
            videoRef.current.muted = false
            // Unlock bgAudio from user gesture chain so it can play on background
            if (bgAudioRef.current && bgAudioRef.current.paused) {
              bgAudioRef.current.volume = 0.01
              bgAudioRef.current.play().then(() => bgAudioRef.current.pause()).catch(() => {})
            }
          }
        }}
        style={{
          width: '100%',
          maxHeight: '30vh',
          aspectRatio: isNativeIOS ? '16 / 9' : undefined,
          display: 'block',
          background: 'var(--bg)',
        }}
      />
      {mini && (
        <div
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            hapticTick()
            resizeRef.current = {
              pointerId: e.pointerId,
              startX: e.clientX,
              startWidth: miniWidth,
              startPosX: miniPos?.x ?? null,
            }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            const r = resizeRef.current
            if (!r || r.pointerId !== e.pointerId) return
            const dx = r.startX - e.clientX // drag left → positive → grow
            const newW = Math.max(140, Math.min(window.innerWidth - 16, r.startWidth + dx))
            setMiniWidth(newW)
            if (r.startPosX !== null) {
              // Anchor right edge: move left by the width delta
              const deltaW = newW - r.startWidth
              setMiniPos(p => p ? { x: Math.max(4, r.startPosX - deltaW), y: p.y } : p)
            }
          }}
          onPointerUp={(e) => {
            const r = resizeRef.current
            if (!r || r.pointerId !== e.pointerId) return
            resizeRef.current = null
            try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
          }}
          style={{
            position: 'absolute',
            left: -22,
            bottom: -22,
            width: 44,
            height: 44,
            cursor: 'nesw-resize',
            touchAction: 'none',
            background: 'transparent',
            zIndex: 2,
          }}
        />
      )}
      <div style={{ display: mini ? 'none' : 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', background: 'var(--surface)', fontSize: '12px', fontFamily: 'monospace' }}>
        <span ref={driftDisplayRef} style={{ color: 'var(--green)' }}>drift: --</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button onClick={() => { hapticTick(); nudgeRef.current?.(-5) }} style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)', fontSize: '10px' }}>-5</button>
          <button onClick={() => { hapticTick(); nudgeRef.current?.(-1) }} style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)', fontSize: '10px' }}>-1</button>
          <span ref={offsetDisplayRef} style={{ color: 'var(--yellow)', minWidth: '60px', textAlign: 'center' }}>0.0s</span>
          <button onClick={() => { hapticTick(); nudgeRef.current?.(1) }} style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)', fontSize: '10px' }}>+1</button>
          <button onClick={() => { hapticTick(); nudgeRef.current?.(5) }} style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)', fontSize: '10px' }}>+5</button>
        </div>
        <button onClick={() => { hapticThump(); setMini(true) }} style={{ padding: '6px 12px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)' }}>MIN</button>
        {phoneOnlyUrl && <button onClick={compMode ? handlePhone : handleComp} style={{ padding: '6px 12px', background: 'var(--surface-hover)', color: compMode ? 'var(--green)' : 'var(--text)', border: '1px solid var(--text-dim)' }}>{compMode ? 'PHONE' : 'COMP'}</button>}
        <button onClick={handleClose} style={{ padding: '6px 12px', background: 'var(--surface-hover)', color: 'var(--red)', border: '1px solid var(--text-dim)' }}>CLOSE</button>
      </div>
    </div>
  )
}
