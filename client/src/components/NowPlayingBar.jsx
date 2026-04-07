import { useState, useRef, useCallback, useEffect } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import { useUIStore } from '../stores/ui'

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
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  ),
  monitor: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  maximize: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  ),
  fullscreen: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  ),
  phone: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <line x1="12" y1="18" x2="12" y2="18" />
    </svg>
  ),
  stop: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  ),
  skipBack: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <polygon points="19 20 9 12 19 4 19 20" />
      <line x1="5" y1="19" x2="5" y2="5" />
    </svg>
  ),
  skipForward: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </svg>
  ),
}

export default function NowPlayingBar({ send }) {
  const pb = usePlaybackStore()
  const phoneOpen = useSyncStore(s => s.phoneOpen)
  const setPhoneOpen = useSyncStore(s => s.setPhoneOpen)
  const addToast = useUIStore(s => s.addToast)

  const [isSeeking, setIsSeeking] = useState(false)
  const [seekPos, setSeekPos] = useState(0)
  const [seekPreview, setSeekPreview] = useState(null)
  const [currentPosVisible, setCurrentPosVisible] = useState(false)
  const [storyboard, setStoryboard] = useState(null)

  const barRef = useRef(null)
  const seekConfirmTimeout = useRef(null)
  const currentPosTimeout = useRef(null)

  const position = isSeeking ? seekPos : pb.position
  const duration = pb.duration || 1
  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0

  // Fetch storyboard data when video changes
  useEffect(() => {
    setStoryboard(null)
    if (!pb.url) return
    const videoId = pb.url.match(/[?&]v=([\w-]+)/)?.[1]
    if (!videoId || pb.isLive) return

    fetch(`/api/storyboard?videoId=${videoId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setStoryboard(data) })
      .catch(() => {})
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
    const frameIndex = Math.floor(seconds / (interval || 2))
    const col = frameIndex % (cols || 5)
    const row = Math.floor(frameIndex / (cols || 5)) % (rows || 5)
    return {
      url,
      bgX: -(col * (width || 160)),
      bgY: -(row * (height || 90)),
      bgWidth: (cols || 5) * (width || 160),
      bgHeight: (rows || 5) * (height || 90),
    }
  }, [storyboard])

  const handlePointerDown = useCallback((e) => {
    e.preventDefault()
    const pos = getSeekPosition(e.clientX)
    setIsSeeking(true)
    setSeekPos(pos)
    setCurrentPosVisible(true)

    // Show seek preview
    const bar = barRef.current
    if (bar) {
      const rect = bar.getBoundingClientRect()
      const x = e.clientX - rect.left
      setSeekPreview({ x, time: pos })
    }

    const handleMove = (ev) => {
      const p = getSeekPosition(ev.clientX || ev.touches?.[0]?.clientX)
      setSeekPos(p)
      if (bar) {
        const rect = bar.getBoundingClientRect()
        const cx = (ev.clientX || ev.touches?.[0]?.clientX) - rect.left
        setSeekPreview({ x: cx, time: p })
      }
    }

    const handleUp = () => {
      setIsSeeking(false)
      setSeekPreview(null)

      // Send seek command
      fetch('/api/seek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: seekPos }),
      }).catch(() => {})

      // Show current position marker, fade after 1.5s
      if (currentPosTimeout.current) clearTimeout(currentPosTimeout.current)
      currentPosTimeout.current = setTimeout(() => setCurrentPosVisible(false), 1500)

      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
    }

    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
  }, [getSeekPosition, seekPos])

  // Use a ref to capture the latest seekPos for the pointerup handler
  const seekPosRef = useRef(seekPos)
  seekPosRef.current = seekPos

  // Override the handleUp to use ref
  const handlePointerDownFixed = useCallback((e) => {
    e.preventDefault()
    const pos = getSeekPosition(e.clientX)
    setIsSeeking(true)
    setSeekPos(pos)
    setCurrentPosVisible(true)

    const bar = barRef.current

    if (bar) {
      const rect = bar.getBoundingClientRect()
      const x = e.clientX - rect.left
      setSeekPreview({ x, time: pos })
    }

    const handleMove = (ev) => {
      const cx = ev.clientX || ev.touches?.[0]?.clientX
      const p = getSeekPosition(cx)
      setSeekPos(p)
      seekPosRef.current = p
      if (bar) {
        const rect = bar.getBoundingClientRect()
        setSeekPreview({ x: cx - rect.left, time: p })
      }
    }

    const handleUp = () => {
      const finalPos = seekPosRef.current
      setIsSeeking(false)
      setSeekPreview(null)

      fetch('/api/seek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: finalPos }),
      }).catch(() => {})

      if (currentPosTimeout.current) clearTimeout(currentPosTimeout.current)
      currentPosTimeout.current = setTimeout(() => setCurrentPosVisible(false), 1500)

      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
    }

    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
  }, [getSeekPosition])

  const togglePlayPause = useCallback(() => {
    fetch('/api/playpause', { method: 'POST' }).catch(() => {})
  }, [])

  const stopPlayback = useCallback(() => {
    fetch('/api/stop', { method: 'POST' }).catch(() => {})
  }, [])

  const moveMonitor = useCallback((monitor) => {
    fetch('/api/move-monitor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitor }),
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
    const newPos = Math.max(0, pb.position - 10)
    fetch('/api/seek', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: newPos }),
    }).catch(() => {})
  }, [pb.position])

  const skipForward = useCallback(() => {
    const newPos = Math.min(duration, pb.position + 30)
    fetch('/api/seek', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: newPos }),
    }).catch(() => {})
  }, [pb.position, duration])

  const thumbnail = pb.url
    ? `https://i.ytimg.com/vi/${pb.url.match(/[?&]v=([\w-]+)/)?.[1]}/default.jpg`
    : ''

  const liveTimeBehind = pb.isLive && pb.duration > 0 ? pb.duration - pb.position : 0

  const frame = seekPreview ? getStoryboardFrame(seekPreview.time) : null

  return (
    <div className="now-playing">
      {/* Button row */}
      <div className="np-btn-row">
        <button
          className={`np-btn${pb.monitor === 'laptop' ? ' active' : ''}`}
          onClick={() => moveMonitor('laptop')}
        >
          {Icons.laptop}
        </button>
        <button
          className={`np-btn${pb.monitor === 'lg' ? ' active' : ''}`}
          onClick={() => moveMonitor('lg')}
        >
          {Icons.monitor}
        </button>
        <button
          className={`np-btn${pb.windowMode === 'maximize' ? ' active' : ''}`}
          onClick={toggleMaximize}
        >
          {Icons.maximize}
        </button>
        <button
          className={`np-btn${pb.windowMode === 'fullscreen' ? ' active' : ''}`}
          onClick={toggleFullscreen}
        >
          {Icons.fullscreen}
        </button>
        <button
          className={`np-btn${phoneOpen ? ' active' : ''}`}
          onClick={watchOnPhone}
        >
          {Icons.phone}
        </button>
        <button className="np-btn" onClick={stopPlayback}>
          {Icons.stop}
        </button>
      </div>

      {/* Title row */}
      <div className="np-top-row">
        <div
          className="np-thumb"
          style={{ backgroundImage: thumbnail ? `url(${thumbnail})` : 'none' }}
          onClick={togglePlayPause}
        />
        <div className="np-info" onClick={togglePlayPause}>
          <div className="np-label">
            {pb.isLive ? 'Live' : 'Now playing'}
            {pb.player ? ` (${pb.player})` : ''}
          </div>
          <div className="np-title">{pb.title || 'Untitled'}</div>
        </div>
        <button className="np-playpause" onClick={togglePlayPause}>
          {pb.paused ? Icons.play : Icons.pause}
        </button>
      </div>

      {/* Progress */}
      <div className="np-controls">
        <div
          className="np-progress-bar"
          ref={barRef}
          onPointerDown={handlePointerDownFixed}
        >
          <div className="np-progress-fill" style={{ width: `${pct}%` }} />
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

          {/* Seek preview */}
          {seekPreview && (
            <div
              className="seek-preview visible"
              style={{ left: `${seekPreview.x}px` }}
            >
              {frame && (
                <div className="seek-preview-thumb">
                  <div style={{
                    width: frame.bgWidth,
                    height: frame.bgHeight,
                    backgroundImage: `url(${frame.url})`,
                    backgroundPosition: `${frame.bgX}px ${frame.bgY}px`,
                    transform: `scale(${200 / (storyboard?.width || 160)})`,
                    transformOrigin: '0 0',
                  }} />
                </div>
              )}
              <div className="seek-preview-time">
                {formatTime(seekPreview.time)}
              </div>
            </div>
          )}
        </div>

        <div className="np-sub-row">
          <button className="np-skip-btn" onClick={skipBack}>-10</button>
          <span className="np-time">{formatTime(position)}</span>
          <span className="np-time" style={{ flex: 1, textAlign: 'center' }}>
            {pb.isLive
              ? (liveTimeBehind < 5 ? 'LIVE' : `-${formatTime(liveTimeBehind)}`)
              : ''
            }
          </span>
          <span className="np-time">{formatTime(duration)}</span>
          <button className="np-skip-btn" onClick={skipForward}>+30</button>
        </div>
      </div>
    </div>
  )
}
