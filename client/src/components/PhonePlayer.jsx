import { useState, useRef, useEffect, useCallback } from 'react'
import Hls from 'hls.js'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import { useUIStore } from '../stores/ui'
import { isNativeIOS, NativePlayer } from '../native/player'
import { tick as hapticTick, thump as hapticThump } from '../haptics'

// Module-level cache so re-mounting PhonePlayer (toggling sync mode
// off/on) doesn't re-run yt-dlp. Sync→computer→sync used to take
// 5-15s round-trip on YouTube DASH because the new mount fetched
// /api/watch-on-phone fresh. Now: if the cached entry matches the
// current pb.url + mode and was loaded <2 min ago, reuse the in-
// memory AVPlayer state. yt-dlp's googlevideo URLs typically stay
// valid much longer than 2 min, but stay conservative since stale
// URLs produce 403s that are confusing to debug.
const NATIVE_LOAD_CACHE_TTL_MS = 2 * 60 * 1000
let _nativeLoadCache = null  // { pbUrl, phoneOnly, at }

// Auto-engage PiP after entering sync mode. Retries until the
// AVPictureInPictureController reports isPictureInPicturePossible
// (load + first frame must land first). Bails if PiP is already
// active or if the user closed sync mode in the meantime.
function autoStartPip() {
  if (!isNativeIOS || !NativePlayer.available) return
  let tries = 0
  const tick = () => {
    tries += 1
    if (tries > 30) return  // ~6s ceiling
    if (!useSyncStore.getState().phoneOpen) return
    if (useSyncStore.getState().pipActive) return
    NativePlayer.startPip().then(() => {}).catch(() => {
      setTimeout(tick, 200)
    })
  }
  setTimeout(tick, 300)
}

// Native AVPlayer position cache — polled on a separate interval so the
// sync loop can read it without awaiting every tick.
let _nativePos = 0
let _nativePosAt = 0
function nativePosNow() {
  const elapsed = (Date.now() - _nativePosAt) / 1000
  return _nativePos + elapsed
}

// Native AVPlayer PDT cache for live streams. `currentDateMs` is AVPlayerItem's
// currentDate() — the wall-clock of the frame on screen — sampled every
// 250ms and interpolated forward by elapsed wall-clock between samples.
let _nativePdtMs = 0
let _nativePdtAt = 0
function nativePdtNow() {
  if (!_nativePdtMs) return 0
  return _nativePdtMs + (Date.now() - _nativePdtAt)
}


export default function PhonePlayer({ send }) {
  const videoRef = useRef(null)
  const readyRef = useRef(false) // true after video starts playing for the first time
  const readyAtRef = useRef(0) // timestamp when video became ready
  const calibOffsetRef = useRef(null) // one-time PDT calibration offset (ms)
  const driftSamplesRef = useRef([]) // moving average for smooth drift display
  const steadyDriftAtRef = useRef(0) // timestamp when drift entered the steady band
  const driftAtSteadyRef = useRef(0) // drift value when steady started
  const lastSeekRef = useRef(0) // timestamp of last live seek (cooldown)
  const seekCountRef = useRef(0) // # of seeks since loading; first few use a tighter cooldown
  // Self-calibrating seek bias (ms). After each seek, AVPlayer's actual
  // landing point tends to undershoot the requested Date by a consistent
  // amount (HLS segment granularity + buffering). We learn the offset
  // post-seek and fold it into subsequent seeks so drift converges to 0.
  const seekBiasRef = useRef(0)
  // Last-seen syncOffsetMs from server — used to detect slider changes
  // and reset calibration state so bias doesn't conflict with new target.
  const lastSyncOffsetRef = useRef(null)
  // One-shot per seek: true right after a seek, cleared once we've
  // folded the post-seek drift into seekBiasRef. Prevents the bias from
  // growing unboundedly when drift is stable between seeks.
  const calibPendingRef = useRef(false)
  const driftDisplayRef = useRef(null)
  const waitForPlayerRef = useRef(null) // track stream-ready wait interval for cleanup
  const hlsRef = useRef(null)
  const syncUrlRef = useRef(null)
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
  const pipActive = useSyncStore(s => s.pipActive)
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
    // Native iOS warm-player fast path. Re-engaging sync mode within
    // 2 min of disengaging it: the AVPlayer is still loaded with the
    // right URL (we only hid its layer when going to computer mode),
    // so skip the slow yt-dlp re-fetch and just unhide. Server-side
    // we still want phoneActive=true and mpv hidden — fire that POST
    // in the background but don't block on it.
    const pbUrlNow = usePlaybackStore.getState().url
    if (
      isNativeIOS && NativePlayer.available && !phoneOnlyUrl &&
      _nativeLoadCache &&
      _nativeLoadCache.pbUrl === pbUrlNow &&
      _nativeLoadCache.phoneOnly === false &&
      (Date.now() - _nativeLoadCache.at) < NATIVE_LOAD_CACHE_TTL_MS
    ) {
      // Restore streamUrl + isLive so the rAF setLayerFrame loop sees
      // a loaded state and tells iOS to show the layer. Without this,
      // the layer stays isHidden=true and the user sees the React
      // placeholder div with no video.
      setStreamUrl(_nativeLoadCache.url)
      setIsLive(_nativeLoadCache.isLive || false)
      readyRef.current = true
      readyAtRef.current = Date.now()
      // Re-trigger the play() since the native player was paused-or-
      // muted while hidden. Server bumps phoneActive + hides mpv.
      NativePlayer.play().then(() => {
        // Chain PiP autostart after play resolves so
        // isPictureInPicturePossible has had a chance to flip true.
        // Was firing immediately and falling into the 6s retry loop.
        autoStartPip()
      }).catch(() => {})
      fetch('/api/watch-on-phone?warm=1', { method: 'POST' }).catch(() => {})
      setLoading(false)
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
          // (Safari can't consume YouTube HLS directly). Native AVPlayer CAN,
          // so use the direct streamUrl on native.
          const useHls = data.isLive && Hls.isSupported()
          const url = phoneOnlyRef.current
            ? data.streamUrl
            : (data.isLive
                ? (isNativeIOS
                    ? data.streamUrl
                    : (useHls ? (data.proxyUrl || data.streamUrl) : `${data.proxyUrl || '/api/phone-hls'}?direct=1`))
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
              // phone-only uses `duration`, watch-on-phone uses `durationSec`.
              // Either way the plugin clamps the AVMutableComposition so
              // YouTube DASH moov-atom metadata reporting 2× duration
              // doesn't propagate to the scrubber.
              durationSec: data.durationSec || data.duration || 0,
              autoplay: true,
              // Sync mode: mpv is the audio source, phone must be muted to
              // avoid a doubled audio track.
              muted: !phoneOnlyRef.current,
            }).then(() => {
              if (!phoneOnlyRef.current) {
                readyRef.current = true
                readyAtRef.current = Date.now()
                // Seed _nativePdtMs immediately. Without this, the
                // 250ms polling interval's first sample arrives
                // 0–250ms after load resolves, deferring the first
                // drift correction by that amount.
                if (data.isLive) {
                  NativePlayer.getLiveState().then((s) => {
                    if (s && s.currentDateMs && s.currentDateMs > 0) {
                      _nativePdtMs = s.currentDateMs
                      _nativePdtAt = Date.now()
                    }
                  }).catch(() => {})
                }
              }
              // Stamp the warm-player cache so a subsequent computer-
              // mode flip + sync flip can skip the yt-dlp re-fetch.
              _nativeLoadCache = {
                pbUrl: usePlaybackStore.getState().url,
                phoneOnly: phoneOnlyRef.current,
                url,
                isLive: !!data.isLive,
                at: Date.now(),
              }
              // Sync mode shows video via PiP, not the inline mini-
              // player panel. Auto-engage PiP once the AVPlayer has
              // first-frame.
              if (!phoneOnlyRef.current) autoStartPip()
            }).catch(() => {})
          }

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
                // keepalive so iOS doesn't drop the fetch when the
                // WebView is backgrounded (lock-screen widget pause
                // arrives there). Without it the server never sees
                // the toggle and mpv stays playing/visible on the Mac.
                fetch('/api/playpause', { method: 'POST', keepalive: true }).catch(() => {}) // unpause mpv
              },
              pause: () => {
                bgAudio.pause(); videoRef.current?.pause()
                fetch('/api/playpause', { method: 'POST', keepalive: true }).catch(() => {}) // pause mpv
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
            waitForPlayerRef.current = { clear: origCleanup }
            return
          }

          // Normal mode: wait for mpv to be playing before loading phone video
          waitForPlayerRef.current = setInterval(() => {
            const pb = usePlaybackStore.getState()
            if (!pb.playing || pb.paused) return
            clearInterval(waitForPlayerRef.current)
            waitForPlayerRef.current = null

            setTimeout(() => {
              const video = videoRef.current
              if (!video) return
              const fullUrl = url.startsWith('/') ? `${location.origin}${url}` : url
              if (data.isLive && Hls.isSupported()) {
                if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
                // 4 segments of hold-back = ~8s lag from live edge (matches
                // what mpv-side sees with default HLS buffering).
                const syncCount = 4
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
                  // Safari native HLS: land ~25s behind live edge for buffer.
                  const liveTailGap = 25
                  const waitSeekable = () => {
                    if (video.seekable?.length > 0) {
                      const seekableEnd = video.seekable.end(video.seekable.length - 1)
                      video.currentTime = Math.max(0, seekableEnd - liveTailGap)
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
      if (waitForPlayerRef.current?.clear) { waitForPlayerRef.current.clear() }
      else if (waitForPlayerRef.current) { clearInterval(waitForPlayerRef.current) }
      waitForPlayerRef.current = null
    }
  }, [phoneOpen, phoneOnlyUrl, addToast])

  // Imperative sync loop — reads store directly, no subscriptions that cause re-renders
  useEffect(() => {
    if (!phoneOpen) return

    let lastRateSend = 0
    // Sanity: make sure mpv speed is at 1.0 when we enter sync mode.
    // Earlier drift-nudging sessions could have left it off.
    send({ type: 'mpv-speed', speed: 1.0 })

    const setDrift = (text) => { const el = driftDisplayRef.current; if (el) el.textContent = text }

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

      // Sync offset changed via the slider → the reported mpv_pdt just
      // jumped by (newOffset - oldOffset) ms, which would otherwise
      // trigger phone's "big drift detected" panic seek with the
      // current seekBiasRef (calibrated for the old offset). Reset
      // calibration state so the system re-converges on the new target
      // without bias interference.
      if (lastSyncOffsetRef.current !== pb.syncOffsetMs) {
        if (lastSyncOffsetRef.current !== null) {
          driftSamplesRef.current = []
          seekBiasRef.current = 0
          calibPendingRef.current = false
          lastSeekRef.current = 0
        }
        lastSyncOffsetRef.current = pb.syncOffsetMs
      }

      // Detect video switch on desktop — reload phone stream with full state reset
      if (pb.url && syncUrlRef.current && syncUrlRef.current !== pb.url) {
        setDrift('video switched, reloading...')
        syncUrlRef.current = pb.url
        readyRef.current = false
        readyAtRef.current = 0
        lastSeekRef.current = 0
        seekCountRef.current = 0
        calibOffsetRef.current = null
        driftSamplesRef.current = []
        fetch('/api/watch-on-phone', { method: 'POST' })
          .then(r => r.json())
          .then(data => {
            if (!data.streamUrl) return
            const isLive = !!data.isLive
            setIsLive(isLive)
            // Native iOS: re-load AVPlayer with the new stream. The HTML
            // <video> isn't the real player on native; AVPlayer is.
            if (isNativeIOS && NativePlayer.available) {
              const absUrl = data.streamUrl.startsWith('/') ? `${location.origin}${data.streamUrl}` : data.streamUrl
              NativePlayer.load({
                url: absUrl,
                videoUrl: data.videoUrl || undefined,
                audioUrl: data.audioUrl || undefined,
                position: data.seconds || 0,
                durationSec: data.durationSec || data.duration || 0,
                autoplay: true,
                muted: !phoneOnlyRef.current,
              }).then(() => {
                readyRef.current = true
                readyAtRef.current = Date.now()
              }).catch(() => {})
              return
            }
            // Web / non-native: reload HTML <video> or hls.js.
            const useHls = isLive && Hls.isSupported()
            const url = isLive
              ? (useHls ? (data.proxyUrl || data.streamUrl) : `${data.proxyUrl || '/api/phone-hls'}?direct=1`)
              : data.streamUrl
            const fullUrl = url.startsWith('/') ? `${location.origin}${url}` : url
            if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
            if (useHls) {
              const hls = new Hls({
                liveSyncDurationCount: 4,
                liveMaxLatencyDurationCount: 10,
                maxLiveSyncPlaybackRate: 1.04,
                lowLatencyMode: false,
              })
              hls.loadSource(fullUrl); hls.attachMedia(video)
              hls.on(Hls.Events.MANIFEST_PARSED, () => {
                video.play().then(() => { readyRef.current = true; readyAtRef.current = Date.now() }).catch(() => {})
              })
              hlsRef.current = hls
            } else {
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
      // 1.5s instead of 5s — the original 5s was overkill, blocking
      // any drift correction for the first half of "tap → in-sync."
      // 1.5s still lets the AVPlayer first frame land + PDT bind
      // before we start seeking.
      if (settleMs < 1500) {
        setDrift(`settling ${((1500 - settleMs) / 1000).toFixed(1)}s...`)
        return
      }
      if (!pb.playing || pb.paused) {
        if (isNativeIOS) {
          // AVPlayer drives playback on native (including PiP). Check
          // its state and bring into agreement. Without this, pausing
          // in the app UI left the PiP window playing.
          NativePlayer.getState().then(s => {
            if (s && !s.paused) NativePlayer.pause().catch(() => {})
          }).catch(() => {})
        } else if (video && !video.paused) {
          video.pause()
        }
        return
      }
      // Resume phone if mpv is playing but phone is paused.
      if (isNativeIOS) {
        NativePlayer.getState().then(s => {
          if (s && s.paused) NativePlayer.play().catch(() => {})
        }).catch(() => {})
      } else if (!isNativeIOS && video.paused) {
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
        // ========================================================
        // LIVE HLS PDT SYNC — see CLAUDE.md "Live Sync Architecture"
        // ========================================================
        // Strategy: Program-Date-Time (PDT) as the single source of
        // truth. The server broadcasts `pb.absoluteMs` = wall-clock ms
        // of the frame mpv is demuxing. AVPlayerItem.currentDate()
        // gives us the same for the phone. We compute drift, and when
        // it exceeds 0.5s we seek the phone via seek(to: Date). A
        // self-calibrating bias compensates for AVPlayer's post-seek
        // undershoot so drift converges to ~0 over a few cycles.
        //
        // To debug: uncomment DEBUG_SYNC_LOG below and curl /tmp/ytctl-client.log
        const DEBUG_SYNC_LOG = false
        const logTick = DEBUG_SYNC_LOG ? (extra) => {
          fetch('/api/client-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              src: 'livesync', tick,
              absoluteMs: pb.absoluteMs, phoneSyncOk: pb.phoneSyncOk,
              serverTs: pb.serverTs, mpvPos: pb.position,
              nativePdt: _nativePdtMs,
              nativePdtAgeMs: _nativePdtAt ? Date.now() - _nativePdtAt : null,
              clockOffset: useSyncStore.getState().clockOffset || 0,
              ...(extra || {}),
            }),
          }).catch(() => {})
        } : () => {}
        if (!isNativeIOS) {
          setDrift('live (web: no sync)')
          send({ type: 'phone-state', drift: 0 })
        } else if (!pb.absoluteMs) {
          setDrift('live (awaiting pdt)')
          send({ type: 'phone-state', drift: 0 })
          if (tick % 5 === 0) logTick({ state: 'awaiting-pdt' })
        } else {
          const phonePdt = nativePdtNow()
          if (!phonePdt) {
            setDrift('live (no native pdt)')
            send({ type: 'phone-state', drift: 0 })
            if (tick % 5 === 0) logTick({ state: 'no-native-pdt' })
          } else {
            const clockOffset = useSyncStore.getState().clockOffset || 0
            const elapsed = pb.serverTs
              ? Math.max(0, Math.min(Date.now() + clockOffset - pb.serverTs, 2000))
              : 0
            // Drift = honest wall-clock delta between mpv's demux frame
            // and phone's displayed frame. Positive = phone behind mpv.
            const mpvPdt = pb.absoluteMs + elapsed
            const drift = (mpvPdt - phonePdt) / 1000
            // Seek target: add seekBiasRef (self-calibrated from past
            // undershoots) plus an audio-lead so phone visibly leads mpv
            // demux enough to match Mac speaker output.
            const AUDIO_LEAD_MS = 0
            const seekTarget = mpvPdt + seekBiasRef.current + AUDIO_LEAD_MS
            // Big-drift guard: if |drift| > 10s, don't pollute the EMA
            // with outliers (stale currentDate from pre-seek AVPlayer
            // state, new stream just started, etc.). We still fire the
            // forced seek below using raw drift. EMA converges cleanly
            // after a few normal-range samples.
            if (Math.abs(drift) < 10) {
              driftSamplesRef.current.push(drift)
              if (driftSamplesRef.current.length > 5) driftSamplesRef.current.shift()
            }
            const smoothed = driftSamplesRef.current.length > 0
              ? driftSamplesRef.current.reduce((a, b) => a + b, 0) / driftSamplesRef.current.length
              : drift // no clean samples yet — fall back to raw so the seek still fires
            // UI: show "syncing…" while drift is huge (initial
            // calibration) or samples are unstable. Show actual value
            // once we're in the steady-state range (<10s drift).
            if (Math.abs(smoothed) > 10) {
              setDrift('live: syncing…')
            } else {
              setDrift(`live drift: ${smoothed.toFixed(2)}s`)
            }
            send({ type: 'phone-state', drift: +smoothed.toFixed(2), mpvPdt: Math.round(mpvPdt), phonePdt: Math.round(phonePdt) })

            const now = Date.now()
            const sinceLastSeek = now - lastSeekRef.current

            // One-shot self-calibration per seek cycle: once settled
            // (>2s since seek) and 3 samples are tight (±80ms), fold 70%
            // of the residual into seekBiasRef. Aggressive factor + force
            // seek after calib converges to near-zero drift in 3-6 seeks
            // even with AVPlayer's per-seek jitter, as the signed-mean of
            // residuals drives the bias to the right value.
            let calibrated = false
            if (calibPendingRef.current && sinceLastSeek > 2000 && driftSamplesRef.current.length >= 3) {
              const min = Math.min(...driftSamplesRef.current)
              const max = Math.max(...driftSamplesRef.current)
              if (max - min < 0.08 && Math.abs(smoothed) > 0.05) {
                const adjust = Math.round(smoothed * 1000 * 0.7)
                seekBiasRef.current += adjust
                calibPendingRef.current = false
                calibrated = true
              }
            }

            // Force a seek right after calibration so the newly-learned
            // bias actually applies. Also fire when drift grows beyond
            // 0.2s even without calibration — otherwise the system can
            // settle at a 0.3s residual forever because that's below
            // the old 0.5s trigger but above the 0.05s calibration
            // floor, so seekBias never updates.
            // First 3 seeks get a tighter 1s cooldown — the bias-
            // learning loop converges faster when initial corrections
            // can fire close together. After that, 2.5s prevents
            // bouncing inside the AVPlayer jitter floor.
            const cooldown = seekCountRef.current < 3 ? 1000 : 2500
            const shouldSeek = (calibrated || Math.abs(smoothed) > 0.2) && sinceLastSeek > cooldown
            if (tick % 3 === 0 || shouldSeek || calibrated) {
              logTick({
                state: 'drift',
                elapsed,
                mpvPdt,
                phonePdt,
                seekTarget,
                seekBias: seekBiasRef.current,
                rawDrift: +drift.toFixed(3),
                smoothedDrift: +smoothed.toFixed(3),
                sinceLastSeekMs: sinceLastSeek,
                shouldSeek,
                calibrated,
              })
            }
            if (shouldSeek) {
              NativePlayer.seekToDate({ epochMs: seekTarget }).then(r => {
                fetch('/api/client-log', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ src: 'livesync', tick, event: 'seekToDate-result', target: seekTarget, bias: seekBiasRef.current, result: r }),
                }).catch(() => {})
              }).catch((err) => {
                fetch('/api/client-log', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ src: 'livesync', tick, event: 'seekToDate-error', err: String(err) }),
                }).catch(() => {})
              })
              lastSeekRef.current = now
              seekCountRef.current = (seekCountRef.current || 0) + 1
              driftSamplesRef.current = []
              calibPendingRef.current = true
              // Kick the local PDT cache forward so the next tick doesn't
              // re-seek before the native poll catches up.
              _nativePdtMs = seekTarget
              _nativePdtAt = now
            }
          }
        }
      } else {
        // VOD sync — hard seek on big drift, plus a "steady state" seek
        // once drift has stabilised in the sub-second band.
        //
        // mpv's time-pos reports DEMUX position, which leads what the
        // speaker is actually playing by ~600ms on macOS (codec buffer +
        // CoreAudio device buffer). The AVPlayer's currentTime is the
        // display frame. Subtract a constant to make both mean the same
        // thing: "what the user currently perceives".
        // mpv's time-pos reports demux position which runs ahead of actual
        // audible playback; phone being visibly behind audio means we need
        // phone to TARGET a later position. Add the compensation rather
        // than subtract.
        const MPV_AUDIO_LAG = 0.4
        const clockOffset = useSyncStore.getState().clockOffset || 0
        const elapsed = pb.serverTs ? Math.max(0, Math.min(Date.now() + clockOffset - pb.serverTs, 2000)) / 1000 : 0
        const mpvPos = pb.position + elapsed + MPV_AUDIO_LAG
        const phonePos = isNativeIOS ? nativePosNow() : (video.currentTime || 0)
        const rawDiff = mpvPos - phonePos

        driftSamplesRef.current.push(rawDiff)
        if (driftSamplesRef.current.length > 5) driftSamplesRef.current.shift()
        const drift = driftSamplesRef.current.reduce((a, b) => a + b, 0) / driftSamplesRef.current.length

        setDrift(`drift: ${drift.toFixed(2)}s`)
        send({ type: 'phone-state', drift: +drift.toFixed(2), mpv: +mpvPos.toFixed(2), phone: +phonePos.toFixed(2) })

        const now3 = Date.now()

        // --- Big-drift seek ---
        const threshold = now3 - lastSeekRef.current > 6000 ? 0.3 : 1.0
        if (Math.abs(drift) > threshold && now3 - lastSeekRef.current > 2500) {
          const target = mpvPos + (isNativeIOS ? 0 : 0.2)
          if (isNativeIOS) {
            NativePlayer.seek(target).catch(() => {})
            _nativePos = target
            _nativePosAt = Date.now()
          } else {
            video.currentTime = target
          }
          lastSeekRef.current = now3
          driftSamplesRef.current = []
          steadyDriftAtRef.current = 0
          send({ type: 'mpv-speed', speed: 1.0 })
          return
        }

        // --- Steady-state one-shot seek ---
        // If drift has been stable (within ±0.05s of its mean) for 4s,
        // and we're outside 30ms, fire a single seek. Since drift is
        // steady there's no oscillation feedback — this one correction
        // should stick.
        if (Math.abs(drift) > 0.03) {
          if (!steadyDriftAtRef.current) {
            steadyDriftAtRef.current = now3
            driftAtSteadyRef.current = drift
          } else if (Math.abs(drift - driftAtSteadyRef.current) > 0.05) {
            // Moved too much — not steady, restart the clock
            steadyDriftAtRef.current = now3
            driftAtSteadyRef.current = drift
          } else if (
            now3 - steadyDriftAtRef.current > 4000 &&
            now3 - lastSeekRef.current > 8000
          ) {
            const target = mpvPos + (isNativeIOS ? 0 : 0.2)
            if (isNativeIOS) {
              NativePlayer.seek(target).catch(() => {})
              _nativePos = target
              _nativePosAt = Date.now()
            } else {
              video.currentTime = target
            }
            lastSeekRef.current = now3
            driftSamplesRef.current = []
            steadyDriftAtRef.current = 0
          }
        } else {
          steadyDriftAtRef.current = 0
        }
      }
    }, 1000)

    return () => {
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
  // tracking picks up the right number after we close, AND persist
  // progress directly via /api/phone-progress. Direct persistence is
  // the authoritative path — relying on mpv to save its own time-pos
  // was fragile (muted mpv can drift, timers throttle when the WebView
  // is backgrounded under PiP, etc.).
  const syncToMpv = useCallback(async () => {
    const url = phoneOnlyUrl
    if (!url) return
    let position = 0
    let duration = 0
    if (isNativeIOS) {
      try { const s = await NativePlayer.getState(); position = s?.position || 0; duration = s?.duration || 0 } catch {}
    } else if (videoRef.current) {
      position = videoRef.current.currentTime || 0
      duration = videoRef.current.duration || 0
    }
    if (position > 0) {
      const pb = usePlaybackStore.getState()
      fetch('/api/seek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position }),
      }).catch(() => {})
      fetch('/api/phone-progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          position,
          duration: duration || pb.duration || 0,
          title: pb.title || '',
          channel: pb.channel || '',
          thumbnail: pb.thumbnail || '',
        }),
        // iOS throttles fetch() when the WebView is suspended (e.g.
        // PiP backgrounded). keepalive lets the request survive being
        // scheduled just as the page is freezing.
        keepalive: true,
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

  // Force one progress save whenever the WebView is about to background
  // (PiP taking over, app switcher, screen lock). iOS throttles timers
  // in background so the 10s interval below is unreliable — this catch
  // ensures the position right before the transition is persisted.
  useEffect(() => {
    if (!phoneOnlyUrl) return
    const onHide = () => { if (document.hidden) syncToMpv() }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
    }
  }, [phoneOnlyUrl, syncToMpv])

  // Periodic sync every 10s so mpv's position tracker (which saves to
  // history) matches the phone player. Cheap: hits /api/seek which just
  // calls mpv's IPC.
  useEffect(() => {
    if (!phoneOnlyUrl) return
    const iv = setInterval(() => { syncToMpv() }, 10000)
    return () => clearInterval(iv)
  }, [phoneOnlyUrl, syncToMpv])

  // Poll native AVPlayer state into the nativePosNow() / nativePdtNow()
  // caches so the sync loop can compute drift without awaiting every tick.
  // Use getLiveState so we pick up both position (VOD sync) and the
  // AVPlayerItem currentDate (live PDT sync) in a single native call.
  useEffect(() => {
    if (!isNativeIOS || !phoneOpen) return
    let alive = true
    const tick = async () => {
      if (!alive) return
      try {
        const s = await NativePlayer.getLiveState()
        if (s) {
          if (typeof s.position === 'number') {
            _nativePos = s.position
            _nativePosAt = Date.now()
          }
          if (typeof s.currentDateMs === 'number' && s.currentDateMs > 0) {
            _nativePdtMs = s.currentDateMs
            _nativePdtAt = Date.now()
          } else {
            _nativePdtMs = 0
          }
        }
      } catch {}
      if (alive) setTimeout(tick, 250)
    }
    tick()
    return () => { alive = false; _nativePdtMs = 0 }
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
    const sync = () => {
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
    }
    // 30Hz instead of 60Hz — every other rAF. The Swift side will
    // also short-circuit on identical args, so this just halves the
    // getBoundingClientRect-induced layout reflows from the React
    // side. 30Hz tracking is plenty for human-eye smoothness.
    let parity = 0
    const tick = () => {
      if ((parity++ & 1) === 0) sync()
      if (alive) requestAnimationFrame(tick)
    }
    const id = requestAnimationFrame(tick)
    // Rotation recovery. iOS's layout takes ~500ms to settle after
    // orientation change. During that window the AVPlayer layer
    // renders at its pre-rotation rect, which shows through as
    // black/wrong-sized area in the mini player ("weird space under
    // the video"). Force the layer hidden for the duration, then let
    // the rAF sync re-enable it against the new layout.
    const onOrientation = () => {
      lastKey = 'hidden'
      NativePlayer.setLayerFrame({ x: 0, y: 0, w: 1, h: 1, visible: false }).catch(() => {})
      ;[300, 500, 700].forEach(t => setTimeout(() => {
        // Reset key so next rAF tick recomputes and re-sends with
        // visible=true against the post-rotation bounding rect.
        lastKey = ''
        sync()
      }, t))
    }
    window.addEventListener('orientationchange', onOrientation)
    window.addEventListener('resize', onOrientation)
    return () => {
      alive = false
      cancelAnimationFrame(id)
      window.removeEventListener('orientationchange', onOrientation)
      window.removeEventListener('resize', onOrientation)
    }
  }, [phoneOpen, streamUrl])

  if (!phoneOpen) return null

  return (
    <div className="phone-player" style={{
      ...((!phoneOpen && !streamUrl) ? { display: 'none' } : {}),
      // While native PiP is active, AVPlayer's layer is already in
      // the PiP window. Hide the inline player so we don't render
      // the video twice (inline + floating) side by side.
      ...(pipActive ? { display: 'none' } : {}),
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
      <div className="phone-player-toolbar" style={{ display: mini ? 'none' : 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', background: 'var(--surface)', fontSize: '12px', fontFamily: 'monospace' }}>
        <span ref={driftDisplayRef} style={{ color: 'var(--green)' }}>drift: --</span>
        <button onClick={() => { hapticThump(); setMini(true) }} style={{ padding: '6px 12px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--text-dim)' }}>MIN</button>
        {phoneOnlyUrl && <button onClick={compMode ? handlePhone : handleComp} style={{ padding: '6px 12px', background: 'var(--surface-hover)', color: compMode ? 'var(--green)' : 'var(--text)', border: '1px solid var(--text-dim)' }}>{compMode ? 'PHONE' : 'COMP'}</button>}
        <button onClick={handleClose} style={{ padding: '6px 12px', background: 'var(--surface-hover)', color: 'var(--red)', border: '1px solid var(--text-dim)' }}>CLOSE</button>
      </div>
    </div>
  )
}
