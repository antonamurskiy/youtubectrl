import { useState, useRef, useCallback } from 'react'
import { useUIStore } from '../stores/ui'

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
  const [contextMenu, setContextMenu] = useState(null)
  const longPressTimer = useRef(null)
  const longPressTriggered = useRef(false)

  const thumbnail = video.thumbnail ||
    (video.videoId ? `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg` : '')

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
        isLive: video.isLive || video.live || false,
        watchPct: video.startPercent || 0,
      }),
    }).catch(() => addToast('Play failed'))
  }, [videoUrl, video.title, video.channel, video.isLive, addToast])

  const handleTouchStart = useCallback((e) => {
    longPressTriggered.current = false
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true
      const touch = e.touches?.[0] || e
      setContextMenu({ x: touch.clientX, y: touch.clientY })
    }, 500)
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const handleContextMenuEvent = useCallback((e) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const handleMoreFromChannel = useCallback(() => {
    if (video.channelId || video.channel) {
      // Search for more from this channel
      const q = video.channel || video.channelId
      useUIStore.getState().setSearch(q)
      useUIStore.getState().setTab('search')
    }
    setContextMenu(null)
  }, [video.channelId, video.channel])

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
        className={`video-card${isPlaying ? ' playing' : ''}`}
        onClick={handlePlay}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onContextMenu={handleContextMenuEvent}
      >
        <div className="thumb-wrap">
          {thumbnail && <img src={thumbnail} alt="" loading="lazy" />}
          {(video.isLive || video.live || video.duration === 'LIVE') && <span className="live-badge">LIVE</span>}
          {(video.upcoming || video.duration === 'SOON') && !video.isLive && !video.live && (
            <span className="live-badge" style={{ background: '#555' }}>SOON</span>
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
                const maxY = window.innerHeight - rect.height - 8
                el.style.top = `${Math.min(contextMenu.y, maxY)}px`
                el.style.left = `${Math.min(contextMenu.x, maxX)}px`
              }
            }}
          >
            <button className="context-menu-item" onClick={handleMoreFromChannel}>
              More from {video.channel || 'channel'}
            </button>
            <button className="context-menu-item" onClick={handleCopyLink}>
              Copy link
            </button>
          </div>
        </>
      )}
    </>
  )
}
