import { useEffect, useRef, useState } from 'react'
import { useSyncStore } from '../stores/sync'
import { usePlaybackStore } from '../stores/playback'

export default function CommentsPanel() {
  const toggleComments = useSyncStore(s => s.toggleComments)
  const url = usePlaybackStore(s => s.url)
  const isLive = usePlaybackStore(s => s.isLive)
  const videoId = url?.match(/[?&]v=([\w-]+)/)?.[1]

  const [comments, setComments] = useState(null) // null = loading
  const [chatMessages, setChatMessages] = useState([])
  const chatListRef = useRef(null)
  const seenIdsRef = useRef(new Set())
  const pollTimerRef = useRef(null)
  const pageTokenRef = useRef(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    }
  }, [])

  // VOD: fetch comments once
  useEffect(() => {
    if (!videoId || isLive) return
    setComments(null)
    fetch(`/api/comments?videoId=${videoId}`)
      .then(r => r.json())
      .then(data => { if (aliveRef.current) setComments(Array.isArray(data) ? data : []) })
      .catch(() => { if (aliveRef.current) setComments([]) })
  }, [videoId, isLive])

  // Live: poll chat
  useEffect(() => {
    if (!videoId || !isLive) return
    setChatMessages([])
    seenIdsRef.current = new Set()
    pageTokenRef.current = null

    const poll = async () => {
      try {
        const tok = pageTokenRef.current
        const r = await fetch(`/api/livechat?videoId=${videoId}${tok ? `&pageToken=${tok}` : ''}`)
        const data = await r.json()
        if (!aliveRef.current) return
        if (data.messages?.length) {
          const fresh = []
          for (const m of data.messages) {
            const id = (m.time || '') + (m.author || '')
            if (seenIdsRef.current.has(id)) continue
            seenIdsRef.current.add(id)
            fresh.push(m)
          }
          if (fresh.length) {
            setChatMessages(prev => [...prev, ...fresh].slice(-500))
            // auto-scroll if near bottom
            requestAnimationFrame(() => {
              const el = chatListRef.current
              if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
                el.scrollTop = el.scrollHeight
              }
            })
          }
        }
        pageTokenRef.current = data.nextPageToken || null
        pollTimerRef.current = setTimeout(poll, data.pollingMs || 5000)
      } catch {
        pollTimerRef.current = setTimeout(poll, 5000)
      }
    }
    poll()
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    }
  }, [videoId, isLive])

  if (!videoId) return null

  return (
    <div className="comments-panel">
      <button className="comments-close" onClick={toggleComments}>×</button>
      {isLive ? (
        <div className="comments-list" ref={chatListRef}>
          {chatMessages.length === 0 && <div className="comments-loading">Waiting for messages…</div>}
          {chatMessages.map((m, i) => (
            <div key={i} className="chat-msg">
              <span
                className="chat-author"
                style={{ color: m.isOwner ? 'var(--green)' : m.isMod ? 'var(--blue)' : 'var(--text-dim)' }}
              >
                {m.author}
              </span>
              <span className="chat-text">{m.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="comments-list">
          {comments === null && <div className="comments-loading">Loading comments…</div>}
          {comments !== null && comments.length === 0 && <div className="comments-loading">No comments</div>}
          {comments && comments.map((c, i) => (
            <div key={i} className="comment">
              <div className="comment-author">{c.author}</div>
              <div className="comment-text">{c.text}</div>
              {(c.publishedAt || c.likes > 0) && (
                <div className="comment-meta">
                  {c.publishedAt}{c.likes > 0 ? ` · ${c.likes} likes` : ''}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
