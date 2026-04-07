import { useState, useEffect, useRef, useCallback } from 'react'
import { useUIStore } from '../stores/ui'
import { usePlaybackStore } from '../stores/playback'
import VideoCard from './VideoCard'

const PAGE_SIZE = 24

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
  const loadGen = useUIStore(s => s.loadGen)
  const nextLoadGen = useUIStore(s => s.nextLoadGen)
  const refreshKey = useUIStore(s => s.refreshKey)
  const refresh = useUIStore(s => s.refresh)
  const nowPlayingUrl = usePlaybackStore(s => s.url)

  const [videos, setVideos] = useState([])
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
      setHasMore(false)
      setNextPage(null)
    }

    let url
    const tab = activeTab === 'search' ? 'search' : activeTab

    switch (tab) {
      case 'home':
        url = `/api/home?limit=${PAGE_SIZE}${page ? `&pageToken=${page}` : ''}`
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
      default:
        url = '/api/home'
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
        setSectionLabel(
          tab === 'search' ? `Search: ${searchQuery}` :
          tab === 'home' ? 'Home' :
          tab === 'live' ? 'Live' :
          tab === 'history' ? 'History' : ''
        )
      }

      setHasMore(tab === 'home' && !!token)
      setNextPage(token)
    } catch (err) {
      console.error('Failed to fetch videos:', err)
    } finally {
      if (gen === genRef.current) {
        setLoading(false)
      }
    }
  }, [activeTab, searchQuery])

  // Re-fetch when tab, search, or refreshKey changes
  useEffect(() => {
    genRef.current += 1
    fetchVideos()
  }, [activeTab, searchQuery, refreshKey, fetchVideos])

  // Infinite scroll for home tab
  useEffect(() => {
    if (!hasMore || loading || activeTab !== 'home') return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          fetchVideos(nextPage)
        }
      },
      { rootMargin: '200px' }
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

        {videos.map((video, i) => (
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

      {hasMore && (
        <div className="loading" ref={loadMoreRef}>
          <div className="spinner" />
        </div>
      )}

    </>
  )
}
