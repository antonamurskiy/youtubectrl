import { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import { useUIStore } from '../stores/ui'
import { copyText } from '../clipboard'
import { tick as hapticTick, thump as hapticThump, selection as hapticSelection, selectionStart as hapticSelectionStart, selectionEnd as hapticSelectionEnd } from '../haptics'
import { AudioOutputIcon } from './SecretMenu'

// Replaces the old cmux focus button in the now-playing bar. Shows the
// current audio output's icon; tap opens a compact picker popover.
function AudioOutputButton() {
  const [outputs, setOutputs] = useState([])
  const [current, setCurrent] = useState('')
  const [open, setOpen] = useState(false)
  const [btDevices, setBtDevices] = useState([])
  const [showBt, setShowBt] = useState(false)
  const addToast = useUIStore(s => s.addToast)
  // Fetch current output on mount so the icon matches reality from
  // first paint (not just after the user opens the popover). Also
  // refresh when the popover is opened in case it changed while
  // closed (e.g. user switched via System Settings or a physical
  // headphone connect).
  useEffect(() => {
    let alive = true
    const load = () => fetch('/api/audio-outputs').then(r => r.json()).then(d => {
      if (!alive) return
      setOutputs(d.outputs || [])
      setCurrent(d.current || '')
    }).catch(() => {})
    load()
    return () => { alive = false }
  }, [open])
  const loadBt = () => fetch('/api/bluetooth-devices').then(r => r.json()).then(d => setBtDevices(d.devices || [])).catch(() => {})
  const pick = (name) => {
    hapticTick()
    fetch('/api/audio-output', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      .then(() => { setCurrent(name); addToast(`→ ${name}`) })
      .catch(() => addToast('Switch failed'))
    setOpen(false)
  }
  const toggleBtDevice = (d) => {
    hapticThump()
    const action = d.connected ? 'disconnect' : 'connect'
    fetch(`/api/bluetooth-${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: d.address }) })
      .then(r => r.json()).then(res => {
        addToast(res.ok ? `${action === 'connect' ? 'Connected' : 'Disconnected'} ${d.name}` : 'Failed')
        loadBt()
      }).catch(() => addToast('Failed'))
  }
  return (
    <>
      <button
        className="np-skip-btn"
        style={{ color: 'var(--text-dim)', opacity: 0.8 }}
        aria-label={`Audio output: ${current || 'unknown'}`}
        onClick={(e) => { e.stopPropagation(); hapticTick(); setOpen(v => !v) }}
      >
        <AudioOutputIcon name={current} />
      </button>
      {open && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 700 }} onClick={() => setOpen(false)} />
          <div style={{
            position: 'fixed', right: 12, zIndex: 701,
            bottom: `calc(var(--np-height, 100px) + var(--safe-bottom) + 8px)`,
            background: '#151515', border: '1px solid var(--border)',
            minWidth: 240, maxWidth: 360, maxHeight: '60vh', overflowY: 'auto',
            userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
          }}>
            {outputs.length === 0 && (
              <div className="secret-menu-item" style={{ color: 'var(--text-dim)' }}>No outputs</div>
            )}
            {outputs.map(name => (
              <button
                key={name}
                className="secret-menu-item"
                style={{ display: 'flex', alignItems: 'center', gap: 8, color: name === current ? 'var(--accent)' : 'var(--text)' }}
                onClick={() => pick(name)}
              >
                <AudioOutputIcon name={name} />
                <span style={{ flex: 1 }}>{name}</span>
                {name === current && <span>●</span>}
              </button>
            ))}
            {/* Bluetooth section — same connect/disconnect pattern as the
                secret menu. Collapsed by default. */}
            <button
              className="secret-menu-item"
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              onClick={() => {
                hapticTick()
                if (!showBt) loadBt()
                setShowBt(v => !v)
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" style={{ flexShrink: 0 }}>
                <polyline points="6 7 18 17 12 22 12 2 18 7 6 17" />
              </svg>
              <span style={{ flex: 1 }}>Bluetooth</span>
              <span style={{ color: 'var(--text-dim)' }}>{showBt ? '▾' : '▸'}</span>
            </button>
            {showBt && btDevices.map(d => {
              const hasSplit = d.batteryLeft != null && d.batteryRight != null
              const batText = hasSplit
                ? `L${d.batteryLeft} R${d.batteryRight}${d.batteryCase != null ? ` C${d.batteryCase}` : ''}`
                : (d.battery != null ? `${d.battery}%` : '')
              const lowest = hasSplit ? Math.min(d.batteryLeft, d.batteryRight) : d.battery
              const batColor = lowest != null && lowest <= 20 ? 'var(--red)' : 'var(--text-dim)'
              return (
                <button
                  key={d.address}
                  className="secret-menu-item"
                  style={{ paddingLeft: 24, color: d.connected ? 'var(--accent)' : 'var(--text)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  onClick={() => toggleBtDevice(d)}
                >
                  <span>{d.connected ? '● ' : '  '}{d.name}</span>
                  {batText && <span style={{ fontSize: 'var(--font-sm)', color: batColor }}>{batText}</span>}
                </button>
              )
            })}
          </div>
        </>,
        document.body
      )}
    </>
  )
}

function formatTime(s) {
  if (!s || s < 0) return '0:00'
  s = Math.floor(s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

// SVG icon components
const Icons = {
  laptop: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  ),
  monitor: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  maximize: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  ),
  fullscreen: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  ),
  phone: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <line x1="12" y1="18" x2="12" y2="18" />
    </svg>
  ),
  stop: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <line x1="8" y1="5" x2="8" y2="19" />
      <line x1="16" y1="5" x2="16" y2="19" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  ),
  skipBack: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <polygon points="19 20 9 12 19 4 19 20" />
      <line x1="5" y1="19" x2="5" y2="5" />
    </svg>
  ),
  skipForward: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </svg>
  ),
}

export default function NowPlayingBar({ send, frontApp, refreshStatus }) {
  const pb = usePlaybackStore(useShallow(s => ({
    position: s.position, duration: s.duration, url: s.url,
    isLive: s.isLive, dvrActive: s.dvrActive, paused: s.paused, playing: s.playing,
    monitor: s.monitor, windowMode: s.windowMode, player: s.player, title: s.title, channel: s.channel, thumbnail: s.thumbnail, visible: s.visible, phoneSyncOk: s.phoneSyncOk,
    height: s.height, videoCodec: s.videoCodec, hwdec: s.hwdec, speed: s.speed,
  })))
  const phoneOpen = useSyncStore(s => s.phoneOpen)
  const phoneOnlyUrl = useSyncStore(s => s.phoneOnlyUrl)
  const setPhoneOpen = useSyncStore(s => s.setPhoneOpen)
  const commentsOpen = useSyncStore(s => s.commentsOpen)
  const toggleComments = useSyncStore(s => s.toggleComments)
  const addToast = useUIStore(s => s.addToast)

  const phoneCtrl = () => useSyncStore.getState().phoneVideoCtrl

  const [isSeeking, setIsSeeking] = useState(false)
  const [seekPos, setSeekPos] = useState(0)
  const [seekPreview, setSeekPreview] = useState(null)
  const [currentPosVisible, setCurrentPosVisible] = useState(false)
  const [storyboard, setStoryboard] = useState(null)
  const [titleMenu, setTitleMenu] = useState(null) // {x,y}
  const longPressTimer = useRef(null)
  const longPressTriggered = useRef(false)
  const touchStartPos = useRef(null)

  const barRef = useRef(null)
  const seekConfirmTimeout = useRef(null)
  const currentPosTimeout = useRef(null)
  const seekCleanupRef = useRef(null)
  const skipPosRef = useRef(null)
  const skipResetTimer = useRef(null)

  const position = isSeeking ? seekPos : pb.position
  const duration = pb.duration || 1
  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0

  // Fetch storyboard data when video changes
  useEffect(() => {
    setStoryboard(null)
    if (!pb.url) return
    const videoId = pb.url.match(/[?&]v=([\w-]+)/)?.[1]
    if (!videoId || pb.isLive) return

    const controller = new AbortController()
    fetch(`/api/storyboard?videoId=${videoId}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setStoryboard(data) })
      .catch(() => {})
    return () => controller.abort()
  }, [pb.url, pb.isLive])

  const getSeekPosition = useCallback((clientX) => {
    const bar = barRef.current
    if (!bar) return 0
    const rect = bar.getBoundingClientRect()
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width))
    return (x / rect.width) * duration
  }, [duration])

  const getStoryboardFrame = useCallback((seconds) => {
    if (!storyboard || !storyboard.url) return null
    const { url, width, height, cols, rows, interval } = storyboard
    const c = cols || 5, r = rows || 5
    const framesPerPage = c * r
    const frameIndex = Math.floor(seconds / (interval || 2))
    const page = Math.floor(frameIndex / framesPerPage)
    const indexInPage = frameIndex % framesPerPage
    const col = indexInPage % c
    const row = Math.floor(indexInPage / c)
    return {
      url: url.replace('M$M', `M${page}`),
      bgX: -(col * (width || 160)),
      bgY: -(row * (height || 90)),
      bgWidth: c * (width || 160),
      bgHeight: r * (height || 90),
    }
  }, [storyboard])

  // Use a ref to capture the latest seekPos for the pointerup handler
  const seekPosRef = useRef(seekPos)
  seekPosRef.current = seekPos

  // Snap raw seek time to a nearby chapter start when within a small percentage of duration.
  // Read chapters live from storyboard so we don't create a TDZ on the later const declaration.
  const snapToChapter = useCallback((rawTime) => {
    const chapters = storyboard?.chapters || []
    if (chapters.length < 2 || duration <= 0) return rawTime
    const threshold = duration * 0.01 // 1% of total duration
    let best = rawTime
    let bestDist = threshold
    for (const ch of chapters) {
      const dist = Math.abs(rawTime - ch.start)
      if (dist < bestDist) { bestDist = dist; best = ch.start }
    }
    return best
  }, [storyboard, duration])

  // Override the handleUp to use ref
  const lastSeekHapticStepRef = useRef(-1)
  const handlePointerDownFixed = useCallback((e) => {
    e.preventDefault()
    const bar = barRef.current
    const rect = bar?.getBoundingClientRect()
    const rawPos = getSeekPosition(e.clientX)
    const pos = snapToChapter(rawPos)
    setIsSeeking(true)
    setSeekPos(pos)
    seekPosRef.current = pos
    setCurrentPosVisible(true)
    hapticSelectionStart()
    lastSeekHapticStepRef.current = Math.floor(pos / 5)

    if (bar && rect) {
      const x = Math.max(100, Math.min(e.clientX - rect.left, rect.width - 100))
      setSeekPreview({ x, time: pos })
    }

    const handleMove = (ev) => {
      const cx = ev.clientX || ev.touches?.[0]?.clientX
      const rawP = getSeekPosition(cx)
      const rectNow = bar?.getBoundingClientRect()
      const p = snapToChapter(rawP)
      setSeekPos(p)
      seekPosRef.current = p
      // Haptic tick every 5s of seek movement
      const step = Math.floor(p / 5)
      if (step !== lastSeekHapticStepRef.current) {
        lastSeekHapticStepRef.current = step
        hapticSelection()
      }
      if (bar && rectNow) {
        setSeekPreview({ x: Math.max(100, Math.min(cx - rectNow.left, rectNow.width - 100)), time: p })
      }
    }

    const handleUp = () => {
      const finalPos = seekPosRef.current
      setIsSeeking(false)
      setSeekPreview(null)
      seekCleanupRef.current = null
      hapticSelectionEnd()

      const ctrl = phoneCtrl()
      if (ctrl) { ctrl.seek(finalPos) }
      else { fetch('/api/seek', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: finalPos }) }).catch(() => {}) }

      if (currentPosTimeout.current) clearTimeout(currentPosTimeout.current)
      currentPosTimeout.current = setTimeout(() => setCurrentPosVisible(false), 1500)

      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
    }

    // Store cleanup so unmount can remove listeners
    seekCleanupRef.current = () => {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
    }

    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
  }, [getSeekPosition, snapToChapter])

  // Clean up seek listeners on unmount
  useEffect(() => {
    return () => { if (seekCleanupRef.current) seekCleanupRef.current() }
  }, [])

  // Expose live now-playing height as a CSS var so other overlays can sit above it
  const rootRef = useRef(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => {
      document.documentElement.style.setProperty('--np-height', `${Math.ceil(el.getBoundingClientRect().height)}px`)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.documentElement.style.removeProperty('--np-height')
    }
  }, [])

  // iOS Safari PWA bug: position:fixed elements keep a stale composited snapshot
  // when the tab is backgrounded. Force a repaint on visibilitychange / pageshow
  // by briefly toggling display, which flushes the layer tree.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const nudge = () => {
      if (document.visibilityState !== 'visible') return
      const prev = el.style.display
      el.style.display = 'none'
      // force reflow
      // eslint-disable-next-line no-unused-expressions
      el.offsetHeight
      el.style.display = prev
    }
    document.addEventListener('visibilitychange', nudge)
    window.addEventListener('pageshow', nudge)
    return () => {
      document.removeEventListener('visibilitychange', nudge)
      window.removeEventListener('pageshow', nudge)
    }
  }, [])

  const togglePlayPause = useCallback(() => {
    hapticTick()
    const ctrl = phoneCtrl()
    if (ctrl) {
      // Prefer ctrl's own paused state (authoritative for phone-only modes);
      // fall back to mpv's pb.paused.
      const isPaused = ctrl.isPaused ? ctrl.isPaused() : pb.paused
      isPaused ? ctrl.play() : ctrl.pause()
      return
    }
    fetch('/api/playpause', { method: 'POST' }).catch(() => {})
  }, [pb.paused])

  const handleTitleTouchStart = useCallback((e) => {
    longPressTriggered.current = false
    const touch = e.touches?.[0] || e
    touchStartPos.current = { x: touch.clientX, y: touch.clientY }
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true
      hapticThump()
      setTitleMenu({ x: touchStartPos.current.x, y: touchStartPos.current.y })
    }, 500)
  }, [])
  const handleTitleTouchMove = useCallback((e) => {
    if (!longPressTimer.current || !touchStartPos.current) return
    const touch = e.touches?.[0] || e
    if (Math.abs(touch.clientX - touchStartPos.current.x) > 10 || Math.abs(touch.clientY - touchStartPos.current.y) > 10) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])
  const handleTitleTouchEnd = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null }
  }, [])
  const handleTitleContextMenu = useCallback((e) => {
    e.preventDefault()
    setTitleMenu({ x: e.clientX, y: e.clientY })
  }, [])
  const handleTitleClick = useCallback(() => {
    if (longPressTriggered.current) return
    togglePlayPause()
  }, [togglePlayPause])

  const stopPlayback = useCallback(() => {
    fetch('/api/stop', { method: 'POST' }).catch(() => {})
    // Also kill any native AVPlayer — it wouldn't be affected by /api/stop
    // (which targets mpv). Handles PiP dismissal + layer park offscreen.
    import('../native/player').then(({ NativePlayer, isNativeIOS }) => {
      if (isNativeIOS) NativePlayer.stop().catch(() => {})
    }).catch(() => {})
    // Also close phone-only session if one is active
    const syncStore = useSyncStore.getState()
    if (syncStore.phoneOnlyUrl) {
      fetch('/api/stop-phone-stream', { method: 'POST' }).catch(() => {})
      syncStore.setPhoneOnly(null)
      syncStore.setPhoneOpen(false)
    }
  }, [])

  const moveMonitor = useCallback((monitor) => {
    fetch('/api/move-monitor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: monitor }),
    }).catch(() => {})
  }, [])

  const toggleMaximize = useCallback(() => {
    fetch('/api/maximize', { method: 'POST' }).catch(() => {})
  }, [])

  const toggleFullscreen = useCallback(() => {
    fetch('/api/fullscreen', { method: 'POST' }).catch(() => {})
  }, [])

  const watchOnPhone = useCallback(() => {
    if (phoneOpen) {
      // Close phone player
      fetch('/api/stop-phone-stream', { method: 'POST' }).catch(() => {})
      setPhoneOpen(false)
      return
    }
    setPhoneOpen(true)
  }, [phoneOpen, setPhoneOpen])

  const skipBack = useCallback(() => {
    hapticTick()
    const ctrl = phoneCtrl()
    // Phone-only: skip relative to the phone video's actual currentTime, not mpv's drifted pb.position
    if (ctrl?.skip) { ctrl.skip(-10); addToast('-10s'); return }
    const base = skipPosRef.current ?? pb.position
    const newPos = Math.max(0, base - 10)
    skipPosRef.current = newPos
    clearTimeout(skipResetTimer.current)
    skipResetTimer.current = setTimeout(() => { skipPosRef.current = null }, 2000)
    if (ctrl) { ctrl.seek(newPos) } else { fetch('/api/seek', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: newPos }) }).catch(() => {}) }
    addToast('-10s')
  }, [pb.position, addToast])

  const skipForward = useCallback(() => {
    hapticTick()
    const ctrl = phoneCtrl()
    if (ctrl?.skip) { ctrl.skip(10); addToast('+10s'); return }
    const base = skipPosRef.current ?? pb.position
    const newPos = Math.min(duration, base + 10)
    skipPosRef.current = newPos
    clearTimeout(skipResetTimer.current)
    skipResetTimer.current = setTimeout(() => { skipPosRef.current = null }, 2000)
    if (ctrl) { ctrl.seek(newPos) } else { fetch('/api/seek', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: newPos }) }).catch(() => {}) }
    addToast('+10s')
  }, [pb.position, duration, addToast])

  const ytId = pb.url?.match(/[?&]v=([\w-]+)/)?.[1]
  const thumbnail = pb.thumbnail || (ytId ? `https://i.ytimg.com/vi/${ytId}/default.jpg` : '')

  const liveTimeBehind = pb.isLive && pb.duration > 0 ? pb.duration - pb.position : 0

  const chapters = storyboard?.chapters || []
  const getChapter = useCallback((time) => {
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (time >= chapters[i].start) return chapters[i]
    }
    return null
  }, [chapters])

  const currentChapter = chapters.length > 0 ? getChapter(position) : null
  const seekChapter = seekPreview && chapters.length > 0 ? getChapter(seekPreview.time) : null
  const frame = seekPreview ? getStoryboardFrame(seekPreview.time) : null

  return (
    <div className="now-playing" ref={rootRef}>
      {/* Progress bar — on top of everything */}
      <div
        className="np-progress-bar"
        ref={barRef}
        onPointerDown={handlePointerDownFixed}
      >
        <div className="np-progress-fill" style={{ width: `${pct}%` }} />
        {chapters.length > 1 && chapters.map((ch, i) => i > 0 && (
          <div key={i} className="np-chapter-mark" style={{ left: `${(ch.start / duration) * 100}%` }} />
        ))}
        <div
          className={`np-progress-thumb${!pb.paused ? ' playing' : ''}`}
          style={{ left: `${pct}%` }}
        />
        {currentPosVisible && (
          <div
            className="np-current-pos visible"
            style={{ left: `${duration > 0 ? (pb.position / duration) * 100 : 0}%` }}
          />
        )}
        {seekPreview && (
          <div
            className="seek-preview visible"
            style={{ left: `${seekPreview.x}px` }}
          >
            {frame && (
              <div className="seek-preview-thumb">
                <div style={{
                  width: '100%',
                  height: '100%',
                  backgroundImage: `url(${frame.url})`,
                  backgroundSize: `${frame.bgWidth * (200 / (storyboard?.width || 160))}px ${frame.bgHeight * (112 / (storyboard?.height || 90))}px`,
                  backgroundPosition: `${frame.bgX * (200 / (storyboard?.width || 160))}px ${frame.bgY * (112 / (storyboard?.height || 90))}px`,
                }} />
              </div>
            )}
            <div className="seek-preview-time">
              {pb.isLive
                ? ((1 - seekPreview.time / duration) * duration < 2 ? 'LIVE' : `-${formatTime(duration - seekPreview.time)}`)
                : formatTime(seekPreview.time)
              }
            </div>
            {seekChapter && <div className="seek-preview-chapter">{seekChapter.title}</div>}
          </div>
        )}
      </div>

      {/* Time row — right below progress bar */}
      <div className="np-sub-row">
        <button className="np-skip-btn" onClick={skipBack}>-10</button>
        <span className="np-time">
          {pb.isLive
            ? (liveTimeBehind < 5 ? 'LIVE' : `-${formatTime(liveTimeBehind)}`)
            : formatTime(position)
          }
        </span>
        <button
          className="np-skip-btn"
          style={{ color: pb.visible === false ? '#d05050' : (pb.visible ? 'var(--green)' : 'var(--text-dim)') }}
          onClick={() => { hapticThump(); fetch('/api/toggle-visibility', { method: 'POST' }).catch(() => {}) }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
            {!pb.visible
              ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></>
              : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>
            }
          </svg>
        </button>
        <span
          className="np-time"
          style={{
            flex: 1,
            textAlign: 'center',
            cursor: pb.isLive ? 'pointer' : 'default',
            // Red = actually at live edge. Dim = scrubbed back; tapping
            // this jumps you forward to live.
            color: pb.isLive
              ? (liveTimeBehind < 5 ? 'var(--red)' : 'var(--text-dim)')
              : undefined,
          }}
          onClick={() => {
            if (!pb.isLive) return
            hapticTick()
            const ctrl = phoneCtrl()
            if (ctrl) { ctrl.seek(Math.max(0, pb.duration - 5)) }
            else { fetch('/api/go-live', { method: 'POST' }).catch(() => {}) }
          }}
        >
          {pb.isLive
            ? (liveTimeBehind < 5 ? 'LIVE' : 'GO LIVE')
            : ''
          }
        </span>
        <AudioOutputButton />

        <span className="np-time">{pb.isLive ? '' : formatTime(duration)}</span>
        <button className="np-skip-btn" onClick={skipForward}>+10</button>
      </div>

      {/* Button row */}
      <div className="np-btn-row">
        <button
          className={`np-btn${pb.monitor === 'laptop' ? ' active' : ''}`}
          onClick={() => { hapticTick(); moveMonitor('laptop') }}
        >
          {Icons.laptop}
        </button>
        <button
          className={`np-btn${pb.monitor === 'lg' ? ' active' : ''}`}
          onClick={() => { hapticTick(); moveMonitor('lg') }}
        >
          {Icons.monitor}
        </button>
        <button
          className={`np-btn${pb.windowMode === 'maximize' ? ' active' : ''}`}
          onClick={() => { hapticThump(); toggleMaximize() }}
        >
          {Icons.maximize}
        </button>
        <button
          className={`np-btn${pb.windowMode === 'fullscreen' ? ' active' : ''}`}
          onClick={() => { hapticThump(); toggleFullscreen() }}
        >
          {Icons.fullscreen}
        </button>
        <button
          className={`np-btn${phoneOpen ? ' active' : ''}`}
          style={pb.phoneSyncOk === false ? { opacity: 0.3 } : undefined}
          onClick={() => { hapticThump(); watchOnPhone() }}
          title={pb.phoneSyncOk === false ? 'No MP4 — phone sync unavailable' : 'Watch on phone'}
        >
          {Icons.phone}
        </button>
        <button
          className={`np-btn${commentsOpen ? ' active' : ''}`}
          onClick={() => { hapticTick(); toggleComments() }}
          title={pb.isLive ? 'Live chat' : 'Comments'}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        <button className="np-btn" onClick={() => { hapticThump(); stopPlayback() }}>
          {Icons.stop}
        </button>
        <button
          className="np-btn"
          style={pb.speed !== 1 ? { color: 'var(--red)' } : undefined}
          onPointerDown={(e) => {
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            e.currentTarget.classList.add('active')
            hapticThump()
            fetch('/api/mpv-speed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speed: 2 }) }).catch(() => {})
          }}
          onPointerUp={(e) => {
            e.currentTarget.classList.remove('active')
            hapticTick()
            fetch('/api/mpv-speed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speed: 1 }) }).catch(() => {})
          }}
          onPointerCancel={(e) => {
            e.currentTarget.classList.remove('active')
            fetch('/api/mpv-speed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speed: 1 }) }).catch(() => {})
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {
            /* Show current mpv rate (live-updated from WS). At 1.0 → `1×`.
             * During hold → `2×`. If some other process nudged speed off
             * and forgot to reset (looking at you, drift sync), the
             * non-1 value will show up here as a visible indicator. */
            (() => {
              const s = pb.speed || 1
              return `${Number.isInteger(s) ? s : s.toFixed(2)}×`
            })()
          }
        </button>
      </div>

      {/* Title row */}
      <div className="np-top-row">
        <div
          className="np-thumb"
          style={{ backgroundImage: thumbnail ? `url(${thumbnail})` : 'none' }}
          onClick={togglePlayPause}
        />
        <div
          className="np-info"
          onClick={handleTitleClick}
          onTouchStart={handleTitleTouchStart}
          onTouchMove={handleTitleTouchMove}
          onTouchEnd={handleTitleTouchEnd}
          onTouchCancel={handleTitleTouchEnd}
          onContextMenu={handleTitleContextMenu}
        >
          <div className="np-label">
            {pb.channel || (pb.isLive ? 'Live' : 'Now playing')}
            {pb.player && (() => {
              const parts = [pb.player]
              if (pb.height) parts.push(`${pb.height}p`)
              if (pb.videoCodec) parts.push(pb.videoCodec.toLowerCase())
              if (pb.hwdec) parts.push(pb.hwdec === 'no' ? 'sw' : 'hw')
              return ` (${parts.join(' · ')})`
            })()}
          </div>
          <div className="np-title">{pb.title || 'Untitled'}</div>
        </div>
        <button className="np-playpause" onClick={togglePlayPause}>
          {pb.paused ? Icons.play : Icons.pause}
        </button>
      </div>

      {titleMenu && createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setTitleMenu(null)}
          />
          <div
            className="context-menu"
            ref={el => {
              if (!el) return
              const rect = el.getBoundingClientRect()
              const maxX = window.innerWidth - rect.width - 8
              let y = titleMenu.y - rect.height - 8
              if (y < 8) y = titleMenu.y + 8
              el.style.top = `${y}px`
              el.style.left = `${Math.min(Math.max(titleMenu.x - rect.width / 2, 8), maxX)}px`
              el.style.zIndex = 9999
            }}
          >
            <button className="context-menu-item" onClick={() => {
              if (pb.channel) useUIStore.getState().setChannel({ name: pb.channel })
              setTitleMenu(null)
            }}>
              More from {pb.channel || 'channel'}
            </button>
            <button className="context-menu-item" onClick={async () => {
              if (pb.url) {
                const ok = await copyText(pb.url)
                addToast(ok ? 'Link copied' : 'Copy failed')
              }
              setTitleMenu(null)
            }}>
              Copy link
            </button>
            <button className="context-menu-item" onClick={() => setTitleMenu(null)} style={{ color: 'var(--accent2)' }}>
              Close
            </button>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}
