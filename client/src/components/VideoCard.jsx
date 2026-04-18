import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useUIStore } from '../stores/ui'
import { useSyncStore } from '../stores/sync'
import { usePlaybackStore } from '../stores/playback'
import { copyText } from '../clipboard'
import { tick as hapticTick, thump as hapticThump } from '../haptics'

// Global single-preview coordinator. Only one card previews at a time.
// Each card reports its current top-y offset when intersecting the
// trigger band; the coordinator picks whichever intersecting card is
// CLOSEST TO THE TOP of the viewport (lowest y value) so previews
// feel like they're "leading" the scroll rather than lagging behind.
const _previewEntries = new Map() // id -> topY
const _previewListeners = new Set()
let _activePreviewId = null
function _recomputeActive() {
  let bestId = null
  let bestY = Infinity
  for (const [id, y] of _previewEntries) {
    if (y < bestY) { bestY = y; bestId = id }
  }
  if (bestId === _activePreviewId) return
  _activePreviewId = bestId
  for (const fn of _previewListeners) fn(_activePreviewId)
}
function claimPreview(id, topY) {
  _previewEntries.set(id, topY)
  _recomputeActive()
}
function releasePreview(id) {
  if (!_previewEntries.has(id)) return
  _previewEntries.delete(id)
  _recomputeActive()
}
function subscribePreview(fn) {
  _previewListeners.add(fn)
  return () => _previewListeners.delete(fn)
}

// Module-level dedup cache: key -> Promise<url|null>. Key includes
// isLive so live and VOD previews for the same id don't collide (live
// format is HLS, VOD is progressive MP4).
const previewUrlCache = new Map()
function getPreviewUrl(videoId, isLive) {
  const key = isLive ? `live:${videoId}` : videoId
  if (previewUrlCache.has(key)) return previewUrlCache.get(key)
  const p = fetch(`/api/preview-url?id=${videoId}${isLive ? '&live=1' : ''}`)
    .then(r => r.json())
    .then(d => d?.url || null)
    .catch(() => { previewUrlCache.delete(key); return null })
  previewUrlCache.set(key, p)
  return p
}

function formatDuration(val) {
  if (!val) return null
  // Already formatted string like "16:27" or "1:02:30" — pass through
  if (typeof val === 'string' && val.includes(':')) return val
  const s = parseInt(val, 10)
  if (isNaN(s)) return null
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

function formatViews(n) {
  if (!n) return ''
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M views'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K views'
  return n + ' views'
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

export default function VideoCard({ video, isPlaying, isActive, onHide }) {
  const addToast = useUIStore(s => s.addToast)
  const gridStyle = useUIStore(s => s.gridStyle)
  const terminalOpen = useSyncStore(s => s.terminalOpen)
  const [contextMenu, setContextMenu] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  // `previewing` = card is in the trigger band / being hovered. We
  // delay actual preview playback by 600ms so the thumbnail is
  // visible during quick scrolls — no flash of video starting and
  // stopping as cards pass through.
  const [previewActive, setPreviewActive] = useState(false)
  useEffect(() => {
    if (!previewing) { setPreviewActive(false); return }
    const t = setTimeout(() => setPreviewActive(true), 600)
    return () => clearTimeout(t)
  }, [previewing])
  const longPressTimer = useRef(null)
  const longPressTriggered = useRef(false)
  const cardRef = useRef(null)
  const touchStartPos = useRef(null)
  const previewTimer = useRef(null)

  const videoId = video.videoId || video.id || video.url?.match(/v=([\w-]+)/)?.[1]
  const thumbnail = video.thumbnail ||
    (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '')
  const [previewUrl, setPreviewUrl] = useState(null)
  const previewRef = useRef(null)

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

  const isLiveVideo = !!(video.isLive || video.live)

  // Prefetch preview URL + pre-buffer media when card is anywhere
  // near the viewport. Wide mode widens the band (800px) because the
  // cards are taller there and auto-preview triggers at center — we
  // need more lead time for `preload="auto"` to actually pull bytes
  // before the card becomes active. Compact mode keeps 200px (only
  // URL fetch, preview still hover-triggered).
  const [inView, setInView] = useState(false)
  useEffect(() => {
    if (!isMobile || !cardRef.current || !videoId) return
    const rootMargin = gridStyle === 'wide' ? '800px 0px' : '200px 0px'
    const observer = new IntersectionObserver(
      ([entry]) => { setInView(entry.isIntersecting) },
      { rootMargin, threshold: 0 }
    )
    observer.observe(cardRef.current)
    return () => observer.disconnect()
  }, [videoId, isMobile, gridStyle])

  // Wide mode auto-preview: when a card scrolls into the center band
  // of the viewport, claim the single shared preview slot. Only one
  // card previews at a time — claims and subscribes to the global
  // coordinator so other cards stop when this one takes over.
  useEffect(() => {
    if (gridStyle !== 'wide') return
    if (!isMobile || !cardRef.current || !videoId) return
    const unsub = subscribePreview((activeId) => {
      setPreviewing(activeId === videoId)
    })
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) claimPreview(videoId, entry.boundingClientRect.top)
        else releasePreview(videoId)
      },
      // Band is top-weighted: top of the card must reach the top third
      // of the viewport to start triggering. Topmost card in the band
      // wins, so previews feel like they're leading the scroll.
      { rootMargin: '-10% 0px -60% 0px', threshold: 0 }
    )
    observer.observe(cardRef.current)
    return () => {
      observer.disconnect()
      unsub()
      releasePreview(videoId)
      setPreviewing(false)
    }
  }, [gridStyle, isMobile, videoId])

  // Fetch preview URL when in view (prefetch) or previewing (desktop hover).
  // Dedups across VideoCard instances sharing the same videoId+liveness.
  useEffect(() => {
    if ((!inView && !previewing) || terminalOpen || !videoId || previewUrl) return
    let cancelled = false
    getPreviewUrl(videoId, isLiveVideo).then((url) => {
      if (!cancelled && url) setPreviewUrl(url)
    })
    return () => { cancelled = true }
  }, [inView, previewing, terminalOpen, videoId, previewUrl, isLiveVideo])

  // Mobile: preview on tap-hold; Desktop: hover
  const handleMouseEnter = useCallback(() => {
    if (!isMobile && videoId) setPreviewing(true)
  }, [isMobile, videoId])
  const handleMouseLeave = useCallback(() => {
    if (!isMobile) setPreviewing(false)
  }, [isMobile])

  const videoUrl = video.url || (video.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : '')

  const handlePlay = useCallback(() => {
    if (longPressTriggered.current) return
    hapticTick()

    fetch('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: videoUrl,
        title: video.title,
        channel: video.channel,
        thumbnail: video.thumbnail || '',
        isLive: video.isLive || video.live || false,
        watchPct: video.startPercent || 0,
      }),
    }).catch(() => addToast('Play failed'))
  }, [videoUrl, video.title, video.channel, video.isLive, addToast])

  const handleCardTouchStart = useCallback((e) => {
    longPressTriggered.current = false
    if (isMobile && videoId && !video.isLive && !video.live) {
      if (previewTimer.current) clearTimeout(previewTimer.current)
      setPreviewing(true)
    }
    // Long-press anywhere on the card opens the context menu (was thumbnail-only before)
    const touch = e.touches?.[0] || e
    touchStartPos.current = { x: touch.clientX, y: touch.clientY }
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true
      hapticThump()
      setContextMenu({ x: touchStartPos.current.x, y: touchStartPos.current.y })
    }, 500)
  }, [isMobile, videoId, video.isLive, video.live])
  const handleCardTouchMove = useCallback((e) => {
    if (!longPressTimer.current || !touchStartPos.current) return
    const touch = e.touches?.[0] || e
    const dx = Math.abs(touch.clientX - touchStartPos.current.x)
    const dy = Math.abs(touch.clientY - touchStartPos.current.y)
    if (dx > 10 || dy > 10) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])
  const handleCardTouchEnd = useCallback((e) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    if (isMobile) {
      previewTimer.current = setTimeout(() => setPreviewing(false), 3000)
    }
    // Fire play immediately on touch end to avoid click delay
    if (!longPressTriggered.current && touchStartPos.current) {
      const touch = e.changedTouches?.[0]
      if (touch) {
        const dx = Math.abs(touch.clientX - touchStartPos.current.x)
        const dy = Math.abs(touch.clientY - touchStartPos.current.y)
        if (dx < 10 && dy < 10) {
          e.preventDefault() // prevent subsequent onClick
          handlePlay()
        }
      }
    }
  }, [isMobile, handlePlay])

  // Clean up preview video resources on unmount
  useEffect(() => {
    return () => {
      if (previewRef.current) {
        previewRef.current.pause()
        previewRef.current.removeAttribute('src')
        previewRef.current.load()
      }
    }
  }, [])

  const handleContextMenuEvent = useCallback((e) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const handleMoreFromChannel = useCallback(() => {
    if (video.platform === 'rumble') {
      useUIStore.getState().setChannel({ name: video.channel, platform: 'rumble' })
    } else if (video.channelId || video.channel) {
      useUIStore.getState().setChannel({ id: video.channelId, name: video.channel })
    }
    setContextMenu(null)
  }, [video.channelId, video.channel, video.platform])

  const handleWatchOnPhone = useCallback(() => {
    // Set playback store so now-playing bar shows the video
    usePlaybackStore.getState().update({
      playing: true, paused: false, url: videoUrl,
      title: video.title, channel: video.channel,
      thumbnail: video.thumbnail || '', isLive: video.isLive || video.live || false,
      position: 0, duration: 0,
    })
    useSyncStore.getState().setPhoneOnly(videoUrl)
    setContextMenu(null)
  }, [videoUrl, video.title, video.channel, video.thumbnail, video.isLive, video.live])

  const handleCopyLink = useCallback(async () => {
    const ok = await copyText(videoUrl)
    addToast(ok ? 'Link copied' : 'Copy failed')
    setContextMenu(null)
  }, [videoUrl, addToast])

  const handleNotInterested = useCallback(async () => {
    const token = video.notInterestedToken
    setContextMenu(null)
    if (!token) {
      addToast('Not available')
      return
    }
    // Optimistically remove from grid; YouTube backend gets told in parallel.
    const id = video.videoId || video.id
    if (id) onHide?.(id)
    try {
      const r = await fetch('/api/not-interested', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await r.json()
      if (!r.ok || !data.ok) addToast(data.error || 'Feedback failed')
      else addToast('Not interested')
    } catch {
      addToast('Feedback failed')
    }
  }, [video.notInterestedToken, video.videoId, video.id, onHide, addToast])

  const durationStr = formatDuration(video.duration || video.lengthSeconds)
  const viewsStr = formatViews(video.views || video.viewCount)
  const agoStr = video.uploadedAt || timeAgo(video.publishedAt || video.uploaded)
  const watchPct = video.watchProgress || video.startPercent ||
    (video.savedPosition > 0 && video.savedDuration > 0 ? (video.savedPosition / video.savedDuration) * 100 : 0)

  const upcomingStr = useMemo(() => {
    if (!video.uploadedAt) return 'SOON'
    const m = video.uploadedAt.match(/(\d+)\/(\d+)\/(\d+),\s*(\d+):(\d+)\s*(AM|PM)/i)
    if (!m) return 'SOON'
    const d = new Date(2000 + parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]), m[6] === 'PM' && m[4] !== '12' ? parseInt(m[4]) + 12 : m[6] === 'AM' && m[4] === '12' ? 0 : parseInt(m[4]), parseInt(m[5]))
    const mins = Math.round((d - Date.now()) / 60000)
    if (mins < 1) return 'SOON'
    if (mins < 60) return `in ${mins}m`
    const h = Math.floor(mins / 60)
    return h < 24 ? `in ${h}h` : `in ${Math.floor(h / 24)}d`
  }, [video.uploadedAt])

  return (
    <>
      <div
        ref={cardRef}
        className={`video-card${isPlaying ? ' playing' : ''}${isPlaying && isActive ? ' active' : ''}`}
        style={{ viewTransitionName: `vc-${(video.videoId || video.id || videoUrl).replace(/[^a-zA-Z0-9_-]/g, '_')}` }}
        role="button"
        tabIndex={0}
        onClick={handlePlay}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePlay() } }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleCardTouchStart}
        onTouchMove={handleCardTouchMove}
        onTouchEnd={handleCardTouchEnd}
        onTouchCancel={handleCardTouchEnd}
        onContextMenu={handleContextMenuEvent}
      >
        <div className="thumb-wrap">
          {thumbnail && <img src={thumbnail} alt="" loading="lazy" onError={(e) => { if (e.target.src.includes('hq720')) e.target.src = e.target.src.replace('hq720', 'hqdefault') }} />}
          {/* Pre-mount video as soon as URL resolves + card is in the
              prefetch band, regardless of whether we're previewing.
              `preload="auto"` pulls bytes in the background so when the
              card becomes active, .play() is instant — no "loading"
              jank mid-scroll. Opacity 0 hides it; previewing flips on
              the playback + visibility together. */}
          {previewUrl && !terminalOpen && inView && (
            <video
              ref={(el) => {
                previewRef.current = el
                if (!el) return
                if (previewActive) el.play().catch(() => {})
                else { try { el.pause() } catch {} }
              }}
              src={previewUrl}
              muted
              loop
              playsInline
              preload="auto"
              style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%',
                objectFit: 'cover',
                zIndex: 2,
                opacity: previewActive ? 1 : 0,
                pointerEvents: previewActive ? 'auto' : 'none',
                transition: 'opacity 150ms ease-out',
              }}
            />
          )}
          {(video.isLive || video.live || video.duration === 'LIVE') && <span className="live-badge">LIVE</span>}
          {(video.upcoming || video.duration === 'SOON') && !video.isLive && !video.live && (
            <span className="live-badge" style={{ background: 'var(--text-dim)' }}>{upcomingStr}</span>
          )}
          {durationStr && !video.isLive && !video.live && !video.upcoming && video.duration !== 'SOON' && video.duration !== 'LIVE' && (
            <span className="duration-badge">{durationStr}</span>
          )}
          {watchPct > 0 && (
            <div className="watch-progress" style={{ width: `${Math.min(watchPct, 100)}%` }} />
          )}
          {isPlaying && (
            <div className="play-indicator">
              <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            </div>
          )}
        </div>
        <div className="video-info">
          <div className="video-title">{video.title}</div>
          <div className="video-channel">{video.channel}</div>
          <div className="video-meta">
            {[viewsStr, agoStr].filter(Boolean).join(' \u00b7 ')}
          </div>
        </div>
      </div>

      {contextMenu && (
        <>
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 699,
            }}
            onClick={closeContextMenu}
          />
          <div
            className="context-menu"
            ref={el => {
              if (el) {
                const rect = el.getBoundingClientRect()
                const maxX = window.innerWidth - rect.width - 8
                const bottomBar = 140 // now-playing bar + scrubber height
                const maxY = window.innerHeight - bottomBar - rect.height
                // Position above the tap point, clamped to viewport
                let y = contextMenu.y - rect.height - 8
                const header = document.querySelector('.header')
                const headerBottom = header ? header.getBoundingClientRect().bottom + 8 : 48
                if (y < headerBottom) y = headerBottom
                if (y > maxY) y = maxY
                el.style.top = `${y}px`
                el.style.left = `${Math.min(Math.max(contextMenu.x - rect.width / 2, 8), maxX)}px`
              }
            }}
          >
            <button className="context-menu-item" onClick={handleMoreFromChannel}>
              More from {video.channel || 'channel'}
            </button>
            <button className="context-menu-item" onClick={handleWatchOnPhone}>
              Watch on phone
            </button>
            <button className="context-menu-item" onClick={handleCopyLink}>
              Copy link
            </button>
            {video.notInterestedToken && (
              <button className="context-menu-item" onClick={handleNotInterested} style={{ color: 'var(--red)' }}>
                Not interested
              </button>
            )}
            <button className="context-menu-item" onClick={closeContextMenu} style={{ color: 'var(--accent2)' }}>
              Close
            </button>
          </div>
        </>
      )}
    </>
  )
}
