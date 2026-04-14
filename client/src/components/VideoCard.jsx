import { useState, useRef, useCallback, useEffect } from 'react'
import { useUIStore } from '../stores/ui'
import { useSyncStore } from '../stores/sync'
import { usePlaybackStore } from '../stores/playback'

// Module-level dedup cache: videoId -> Promise<url|null>.
// Multiple VideoCard instances for the same video share one fetch.
const previewUrlCache = new Map()
function getPreviewUrl(videoId) {
  if (previewUrlCache.has(videoId)) return previewUrlCache.get(videoId)
  const p = fetch(`/api/preview-url?id=${videoId}`)
    .then(r => r.json())
    .then(d => d?.url || null)
    .catch(() => { previewUrlCache.delete(videoId); return null })
  previewUrlCache.set(videoId, p)
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

export default function VideoCard({ video, isPlaying }) {
  const addToast = useUIStore(s => s.addToast)
  const terminalOpen = useSyncStore(s => s.terminalOpen)
  const [contextMenu, setContextMenu] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const longPressTimer = useRef(null)
  const longPressTriggered = useRef(false)
  const cardRef = useRef(null)

  const videoId = video.videoId || video.id || video.url?.match(/v=([\w-]+)/)?.[1]
  const thumbnail = video.thumbnail ||
    (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '')
  const [previewUrl, setPreviewUrl] = useState(null)
  const previewRef = useRef(null)

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

  // Prefetch preview URL when card scrolls into view (mobile)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    if (!isMobile || !cardRef.current || !videoId || video.isLive || video.live) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true) },
      { rootMargin: '200px 0px', threshold: 0 }
    )
    observer.observe(cardRef.current)
    return () => observer.disconnect()
  }, [videoId, video.isLive, video.live, isMobile])

  // Fetch preview URL when in view (prefetch) or previewing (desktop hover).
  // Dedups across VideoCard instances sharing the same videoId.
  useEffect(() => {
    if ((!inView && !previewing) || terminalOpen || !videoId || previewUrl || video.isLive || video.live) return
    let cancelled = false
    getPreviewUrl(videoId).then((url) => {
      if (!cancelled && url) setPreviewUrl(url)
    })
    return () => { cancelled = true }
  }, [inView, previewing, terminalOpen, videoId, previewUrl, video.isLive, video.live])

  // Mobile: preview on tap-hold; Desktop: hover
  const handleMouseEnter = useCallback(() => {
    if (!isMobile && videoId && !video.isLive && !video.live) setPreviewing(true)
  }, [isMobile, videoId, video.isLive, video.live])
  const handleMouseLeave = useCallback(() => {
    if (!isMobile) setPreviewing(false)
  }, [isMobile])
  const previewTimer = useRef(null)
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
  const handleCardTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    if (isMobile) {
      previewTimer.current = setTimeout(() => setPreviewing(false), 3000)
    }
  }, [isMobile])

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

  const videoUrl = video.url || (video.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : '')

  const handlePlay = useCallback(() => {
    if (longPressTriggered.current) return

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

  const touchStartPos = useRef(null)

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

  const handleCopyLink = useCallback(() => {
    navigator.clipboard?.writeText(videoUrl)
      .then(() => addToast('Link copied'))
      .catch(() => addToast('Copy failed'))
    setContextMenu(null)
  }, [videoUrl, addToast])

  const durationStr = formatDuration(video.duration || video.lengthSeconds)
  const viewsStr = formatViews(video.views || video.viewCount)
  const agoStr = video.uploadedAt || timeAgo(video.publishedAt || video.uploaded)
  const watchPct = video.watchProgress || video.startPercent ||
    (video.savedPosition > 0 && video.savedDuration > 0 ? (video.savedPosition / video.savedDuration) * 100 : 0)

  return (
    <>
      <div
        ref={cardRef}
        className={`video-card${isPlaying ? ' playing' : ''}`}
        onClick={handlePlay}
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
          {previewing && !terminalOpen && previewUrl && (
            <video
              ref={(el) => { previewRef.current = el; if (el) el.play().catch(() => {}) }}
              src={previewUrl}
              muted
              loop
              playsInline
              preload="auto"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: 2 }}
            />
          )}
          {(video.isLive || video.live || video.duration === 'LIVE') && <span className="live-badge">LIVE</span>}
          {(video.upcoming || video.duration === 'SOON') && !video.isLive && !video.live && (
            <span className="live-badge" style={{ background: 'var(--text-dim)' }}>
              {(() => {
                if (!video.uploadedAt) return 'SOON'
                const m = video.uploadedAt.match(/(\d+)\/(\d+)\/(\d+),\s*(\d+):(\d+)\s*(AM|PM)/i)
                if (!m) return 'SOON'
                const d = new Date(2000 + parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]), m[6] === 'PM' && m[4] !== '12' ? parseInt(m[4]) + 12 : m[6] === 'AM' && m[4] === '12' ? 0 : parseInt(m[4]), parseInt(m[5]))
                const mins = Math.round((d - Date.now()) / 60000)
                if (mins < 1) return 'SOON'
                if (mins < 60) return `in ${mins}m`
                const h = Math.floor(mins / 60)
                return h < 24 ? `in ${h}h` : `in ${Math.floor(h / 24)}d`
              })()}
            </span>
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
                const safeTop = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 48
                if (y < safeTop) y = safeTop
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
            <button className="context-menu-item" onClick={closeContextMenu} style={{ color: 'var(--accent2)' }}>
              Close
            </button>
          </div>
        </>
      )}
    </>
  )
}
