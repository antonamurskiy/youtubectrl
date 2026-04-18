import { useState, useEffect, useRef, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { useUIStore } from '../stores/ui'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import VideoCard from './VideoCard'

const PAGE_SIZE = 24

const tabCache = new Map()
function cacheKeyFor(tab, searchQuery, channelQuery) {
  if (tab === 'filtered') return null
  if (tab === 'search') return searchQuery ? `search:${searchQuery}` : null
  if (tab === 'channel') return channelQuery ? `channel:${channelQuery.id || channelQuery.name}` : null
  return tab
}

function ShortCard({ short }) {
  const terminalOpen = useSyncStore(s => s.terminalOpen)
  const [previewing, setPreviewing] = useState(false)
  const [previewUrl, setPreviewUrl] = useState(null)
  const cardRef = useRef(null)
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

  // No auto-preview on mobile — only preview on desktop hover

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
  const addToast = useUIStore(s => s.addToast)
  const setRefreshing = useUIStore(s => s.setRefreshing)
  const setFilteredVideos = useUIStore(s => s.setFilteredVideos)
  const gridStyle = useUIStore(s => s.gridStyle)
  const gridClass = `video-grid${gridStyle === 'wide' ? ' video-grid--wide' : ''}`
  const nowPlayingUrl = usePlaybackStore(s => s.url)
  const nowPaused = usePlaybackStore(s => s.paused)

  const [videos, setVideos] = useState([])
  const [shorts, setShorts] = useState([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [nextPage, setNextPage] = useState(null)
  const [sectionLabel, setSectionLabel] = useState('')
  const [channelInfo, setChannelInfo] = useState(null) // { id, name, thumbnail, subscriberCount, subscribed }
  const [subBusy, setSubBusy] = useState(false)

  const genRef = useRef(0)
  const loadMoreRef = useRef(null)

  const fetchVideos = useCallback(async (page = null, opts = {}) => {
    const { silent = false, toastOnDone = false } = opts
    const gen = genRef.current

    if (!page && !silent) {
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
      case 'ru':
        url = '/api/rumble'
        break
      case 'search':
        if (!searchQuery) return setLoading(false)
        url = `/api/search?q=${encodeURIComponent(searchQuery)}`
        break
      case 'channel':
        if (!channelQuery) return setLoading(false)
        if (channelQuery.platform === 'rumble') {
          url = `/api/rumble?channel=${encodeURIComponent(channelQuery.name)}`
        } else {
          url = channelQuery.id
            ? `/api/channel?id=${encodeURIComponent(channelQuery.id)}`
            : `/api/channel?name=${encodeURIComponent(channelQuery.name)}`
        }
        break
      default:
        url = '/api/home?feed=recommended'
    }

    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()

      // Discard stale responses
      if (gen !== genRef.current) return

      const items = data.videos || data.items || data || []
      const token = data.nextPageToken || null

      const label =
        tab === 'search' ? `Search: ${searchQuery}` :
        tab === 'rec' ? 'Recommended' :
        tab === 'subs' ? 'Subscriptions' :
        tab === 'home' ? 'Home' :
        tab === 'live' ? 'Live' :
        tab === 'history' ? 'History' :
        tab === 'ru' ? 'Rumble' :
        tab === 'channel' ? (channelQuery?.name || 'Channel') :
        tab === 'filtered' ? 'Filtered' : ''

      const newHasMore = (tab === 'home' || tab === 'rec' || tab === 'subs') && !!token

      const apply = () => {
        if (page) {
          setVideos(prev => {
            const next = [...prev, ...items]
            const key = cacheKeyFor(tab, searchQuery, channelQuery)
            if (key) {
              const prevCache = tabCache.get(key) || {}
              tabCache.set(key, { ...prevCache, videos: next, hasMore: newHasMore, nextPage: token })
            }
            return next
          })
        } else {
          setVideos(items)
          setShorts(data.shorts || [])
          if (data.filtered?.length) setFilteredVideos(data.filtered)
          setSectionLabel(label)
          if (tab === 'channel') setChannelInfo(data.channel || null)
          else setChannelInfo(null)
          const key = cacheKeyFor(tab, searchQuery, channelQuery)
          if (key) {
            tabCache.set(key, {
              videos: items,
              shorts: data.shorts || [],
              sectionLabel: label,
              hasMore: newHasMore,
              nextPage: token,
              channel: data.channel || null,
            })
          }
        }
        setHasMore(newHasMore)
        setNextPage(token)
      }

      // Silent background refresh: animate the reshuffle via the View
      // Transitions API so cards slide to their new positions instead of
      // popping. Falls back to a plain setState in browsers without it.
      if (silent && typeof document !== 'undefined' && document.startViewTransition) {
        document.startViewTransition(() => flushSync(apply))
      } else {
        apply()
      }
      if (toastOnDone && gen === genRef.current) {
        addToast(items.length ? 'Updated' : 'No new videos')
      }
    } catch (err) {
      console.error('Failed to fetch videos:', err)
      if (toastOnDone && gen === genRef.current) addToast('Refresh failed')
    } finally {
      if (gen === genRef.current) {
        setLoading(false)
        if (toastOnDone) setRefreshing(false)
      }
    }
  }, [activeTab, searchQuery, channelQuery, addToast, setRefreshing])

  // Re-fetch when tab, search, or refreshKey changes.
  // If we have cached data for this tab, render it instantly and refresh in
  // the background so the swap is invisible.
  const prevRefreshKeyRef = useRef(refreshKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    genRef.current += 1
    const tab = activeTab === 'search' ? 'search' : activeTab
    const key = cacheKeyFor(tab, searchQuery, channelQuery)
    const isRefresh = refreshKey !== prevRefreshKeyRef.current
    prevRefreshKeyRef.current = refreshKey
    if (isRefresh) {
      // Manual refresh: keep current videos visible, reshuffle in the
      // background via view transitions, toast the outcome.
      setRefreshing(true)
      fetchVideos(null, { silent: true, toastOnDone: true })
      return
    }
    const cached = key ? tabCache.get(key) : null
    if (cached) {
      setVideos(cached.videos)
      setShorts(cached.shorts)
      setSectionLabel(cached.sectionLabel)
      setHasMore(cached.hasMore)
      setNextPage(cached.nextPage)
      setChannelInfo(tab === 'channel' ? (cached.channel || null) : null)
      setLoading(false)
      fetchVideos(null, { silent: true })
    } else {
      if (tab !== 'channel') setChannelInfo(null)
      fetchVideos()
    }
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

  const toggleSub = async () => {
    if (!channelInfo?.id || subBusy) return
    const nextSubscribed = !channelInfo.subscribed
    setSubBusy(true)
    // Optimistic update
    setChannelInfo(ci => ci ? { ...ci, subscribed: nextSubscribed } : ci)
    try {
      const r = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: channelInfo.id, subscribe: nextSubscribed }),
      })
      const data = await r.json()
      if (!r.ok) {
        // Rollback
        setChannelInfo(ci => ci ? { ...ci, subscribed: !nextSubscribed } : ci)
        addToast(data.error || 'Subscription failed')
      } else {
        addToast(nextSubscribed ? 'Subscribed' : 'Unsubscribed')
        // Write-through to cache so tab switches don't flicker back
        const key = cacheKeyFor('channel', searchQuery, channelQuery)
        if (key) {
          const cached = tabCache.get(key)
          if (cached?.channel) {
            tabCache.set(key, { ...cached, channel: { ...cached.channel, subscribed: nextSubscribed } })
          }
        }
      }
    } catch (e) {
      setChannelInfo(ci => ci ? { ...ci, subscribed: !nextSubscribed } : ci)
      addToast('Subscription failed')
    } finally {
      setSubBusy(false)
    }
  }

  const fmtSubs = (n) => {
    if (n == null) return ''
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M subscribers`
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K subscribers`
    return `${n} subscribers`
  }

  return (
    <>
      {activeTab === 'channel' && channelInfo && (
        <div className="channel-header">
          {channelInfo.thumbnail && (
            <img className="channel-avatar" src={channelInfo.thumbnail} alt="" />
          )}
          <div className="channel-info">
            <div className="channel-name">{channelInfo.name || channelQuery?.name || 'Channel'}</div>
            {channelInfo.subscriberCount != null && (
              <div className="channel-subs">{fmtSubs(channelInfo.subscriberCount)}</div>
            )}
          </div>
          <button
            className={`channel-sub-btn${channelInfo.subscribed ? ' subscribed' : ''}`}
            onClick={toggleSub}
            disabled={subBusy || !channelInfo.id}
          >
            {channelInfo.subscribed ? 'Subscribed' : 'Subscribe'}
          </button>
        </div>
      )}
      <div className={gridClass}>
        {loading && <SkeletonCards />}

        {!loading && videos.length === 0 && (
          <div className="empty-state">
            No videos found
          </div>
        )}

        {videos.slice(0, PAGE_SIZE).map((video) => (
          <VideoCard
            key={video.videoId || video.id || video.url}
            video={video}
            isPlaying={nowPlayingUrl && (
              nowPlayingUrl === video.url ||
              nowPlayingUrl.includes(video.videoId)
            )}
            isActive={!nowPaused}
            onHide={(id) => setVideos(vs => vs.filter(v => (v.videoId || v.id) !== id))}
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
        <div className={gridClass}>
          {videos.slice(PAGE_SIZE).map((video) => (
            <VideoCard
              key={video.videoId || video.id || video.url}
              video={video}
              isPlaying={nowPlayingUrl && (
                nowPlayingUrl === video.url ||
                nowPlayingUrl.includes(video.videoId)
              )}
              onHide={(id) => setVideos(vs => vs.filter(v => (v.videoId || v.id) !== id))}
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
