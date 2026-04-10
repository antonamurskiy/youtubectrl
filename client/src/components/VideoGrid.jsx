import { useState, useEffect, useRef, useCallback } from 'react'
import { useUIStore } from '../stores/ui'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import VideoCard from './VideoCard'

const PAGE_SIZE = 24

function ShortCard({ short }) {
  const terminalOpen = useSyncStore(s => s.terminalOpen)
  const [previewing, setPreviewing] = useState(false)
  const [previewUrl, setPreviewUrl] = useState(null)
  const cardRef = useRef(null)
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

  // Mobile: scroll-based preview
  useEffect(() => {
    if (!isMobile || !cardRef.current) return
    const observer = new IntersectionObserver(
      ([entry]) => setPreviewing(entry.isIntersecting),
      { rootMargin: '-20% 0px -20% 0px', threshold: 0 }
    )
    observer.observe(cardRef.current)
    return () => observer.disconnect()
  }, [isMobile])

  useEffect(() => {
    if (!previewing || terminalOpen || previewUrl) return
    const controller = new AbortController()
    fetch(`/api/preview-url?id=${short.id}`, { signal: controller.signal })
      .then(r => r.json())
      .then(d => { if (d.url) setPreviewUrl(d.url) })
      .catch(() => {})
    return () => controller.abort()
  }, [previewing, terminalOpen, short.id, previewUrl])

  return (
    <div
      ref={cardRef}
      className="shorts-card"
      onMouseEnter={() => { if (!isMobile) setPreviewing(true) }}
      onMouseLeave={() => { if (!isMobile) setPreviewing(false) }}
      onClick={() => {
        fetch('/api/play', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${short.id}`, title: short.title }),
        }).catch(() => {})
      }}
    >
      <div className="shorts-thumb-wrap">
        <img src={short.thumbnail} alt="" loading="lazy" />
        {previewing && !terminalOpen && previewUrl && (
          <video
            src={previewUrl}
            muted
            loop
            playsInline
            autoPlay
            preload="auto"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
      </div>
      <div className="shorts-title">{short.title}</div>
      <div className="shorts-views">{short.views}</div>
    </div>
  )
}

function SkeletonCards() {
  return Array.from({ length: 6 }, (_, i) => (
    <div className="skeleton-card" key={i}>
      <div className="skeleton-thumb" />
      <div className="skeleton-lines">
        <div className="skeleton-line" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
      </div>
    </div>
  ))
}

export default function VideoGrid() {
  const activeTab = useUIStore(s => s.activeTab)
  const searchQuery = useUIStore(s => s.searchQuery)
  const channelQuery = useUIStore(s => s.channelQuery)
  const loadGen = useUIStore(s => s.loadGen)
  const nextLoadGen = useUIStore(s => s.nextLoadGen)
  const refreshKey = useUIStore(s => s.refreshKey)
  const refresh = useUIStore(s => s.refresh)
  const setFilteredVideos = useUIStore(s => s.setFilteredVideos)
  const nowPlayingUrl = usePlaybackStore(s => s.url)

  const [videos, setVideos] = useState([])
  const [shorts, setShorts] = useState([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [nextPage, setNextPage] = useState(null)
  const [sectionLabel, setSectionLabel] = useState('')

  const genRef = useRef(0)
  const loadMoreRef = useRef(null)

  const fetchVideos = useCallback(async (page = null) => {
    const gen = genRef.current

    if (!page) {
      setLoading(true)
      setVideos([])
      setShorts([])
      setHasMore(false)
      setNextPage(null)
    }

    let url
    const tab = activeTab === 'search' ? 'search' : activeTab

    // Filtered tab uses stored data, no fetch needed
    if (tab === 'filtered') {
      const fv = useUIStore.getState().filteredVideos
      setVideos(fv)
      setShorts([])
      setSectionLabel(`Filtered (${fv.length})`)
      setHasMore(false)
      setNextPage(null)
      setLoading(false)
      return
    }

    switch (tab) {
      case 'rec':
        url = `/api/home?feed=recommended${page ? `&page=${page}` : ''}`
        break
      case 'subs':
        url = `/api/home?feed=subscriptions${page ? `&page=${page}` : ''}`
        break
      case 'home':
        url = `/api/home${page ? `?page=${page}` : ''}`
        break
      case 'live':
        url = '/api/live'
        break
      case 'history':
        url = '/api/history'
        break
      case 'search':
        if (!searchQuery) return setLoading(false)
        url = `/api/search?q=${encodeURIComponent(searchQuery)}`
        break
      case 'channel':
        if (!channelQuery) return setLoading(false)
        url = channelQuery.id
          ? `/api/channel?id=${encodeURIComponent(channelQuery.id)}`
          : `/api/channel?name=${encodeURIComponent(channelQuery.name)}`
        break
      default:
        url = '/api/home?feed=recommended'
    }

    try {
      const res = await fetch(url)
      const data = await res.json()

      // Discard stale responses
      if (gen !== genRef.current) return

      const items = data.videos || data.items || data || []
      const token = data.nextPageToken || null

      if (page) {
        setVideos(prev => [...prev, ...items])
      } else {
        setVideos(items)
        setShorts(data.shorts || [])
        if (data.filtered?.length) setFilteredVideos(data.filtered)
        setSectionLabel(
          tab === 'search' ? `Search: ${searchQuery}` :
          tab === 'rec' ? 'Recommended' :
          tab === 'subs' ? 'Subscriptions' :
          tab === 'home' ? 'Home' :
          tab === 'live' ? 'Live' :
          tab === 'history' ? 'History' :
          tab === 'channel' ? (channelQuery?.name || 'Channel') :
          tab === 'filtered' ? 'Filtered' : ''
        )
      }

      setHasMore((tab === 'home' || tab === 'rec' || tab === 'subs') && !!token)
      setNextPage(token)
    } catch (err) {
      console.error('Failed to fetch videos:', err)
    } finally {
      if (gen === genRef.current) {
        setLoading(false)
      }
    }
  }, [activeTab, searchQuery, channelQuery])

  // Re-fetch when tab, search, or refreshKey changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    genRef.current += 1
    fetchVideos()
  }, [activeTab, searchQuery, channelQuery, refreshKey])

  // Infinite scroll for home tab
  useEffect(() => {
    if (!hasMore || loading || !['home', 'rec', 'subs'].includes(activeTab)) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          fetchVideos(nextPage)
        }
      },
      { rootMargin: '800px' }
    )

    const el = loadMoreRef.current
    if (el) observer.observe(el)

    return () => {
      if (el) observer.unobserve(el)
    }
  }, [hasMore, loading, activeTab, nextPage, fetchVideos])

  return (
    <>
      <div className="video-grid">
        {loading && <SkeletonCards />}

        {!loading && videos.length === 0 && (
          <div className="empty-state">
            No videos found
          </div>
        )}

        {videos.slice(0, PAGE_SIZE).map((video, i) => (
          <VideoCard
            key={video.url || video.videoId || i}
            video={video}
            isPlaying={nowPlayingUrl && (
              nowPlayingUrl === video.url ||
              nowPlayingUrl.includes(video.videoId)
            )}
          />
        ))}
      </div>

      {shorts.length > 0 && (
        <div className="shorts-section">
          <div className="shorts-label">Shorts</div>
          <div className="shorts-row">
            {shorts.map((s) => (
              <ShortCard key={s.id} short={s} />
            ))}
          </div>
        </div>
      )}

      {videos.length > PAGE_SIZE && (
        <div className="video-grid">
          {videos.slice(PAGE_SIZE).map((video, i) => (
            <VideoCard
              key={video.url || video.videoId || `p${i}`}
              video={video}
              isPlaying={nowPlayingUrl && (
                nowPlayingUrl === video.url ||
                nowPlayingUrl.includes(video.videoId)
              )}
            />
          ))}
        </div>
      )}

      {hasMore && (
        <div className="loading" ref={loadMoreRef}>
          <div className="spinner" />
        </div>
      )}

    </>
  )
}
