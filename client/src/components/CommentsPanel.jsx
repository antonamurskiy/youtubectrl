import { useEffect, useRef, useState } from 'react'
import { useSyncStore } from '../stores/sync'
import { usePlaybackStore } from '../stores/playback'

// Deterministic per-author color via djb2 hash → HSL.
// Keeps saturation/lightness fixed so the Afterglow bg stays readable.
function authorColor(name) {
  let h = 5381
  for (let i = 0; i < (name || '').length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0
  const hue = Math.abs(h) % 360
  return `hsl(${hue}, 65%, 72%)`
}

export default function CommentsPanel() {
  const toggleComments = useSyncStore(s => s.toggleComments)
  const url = usePlaybackStore(s => s.url)
  const isLive = usePlaybackStore(s => s.isLive)
  const videoId = url?.match(/[?&]v=([\w-]+)/)?.[1]

  const [comments, setComments] = useState(null) // null = loading
  const [chatMessages, setChatMessages] = useState([])
  const chatListRef = useRef(null)
  const aliveRef = useRef(true)
  const stickToBottomRef = useRef(true)
  const programmaticScrollRef = useRef(0)
  const chatWsRef = useRef(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (chatWsRef.current) { try { chatWsRef.current.close() } catch {} chatWsRef.current = null }
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

  // Live: subscribe to server-paced /ws/livechat feed
  useEffect(() => {
    if (!videoId || !isLive) return
    setChatMessages([])

    const scrollToBottom = () => {
      requestAnimationFrame(() => {
        const el = chatListRef.current
        if (!el || !stickToBottomRef.current) return
        programmaticScrollRef.current = Date.now() + 700
        try { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }) }
        catch { el.scrollTop = el.scrollHeight }
      })
    }

    let closed = false
    let reconnectTimer = null
    const connect = () => {
      if (closed) return
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${location.host}/ws/livechat?videoId=${videoId}`)
      chatWsRef.current = ws
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          if (data.type === 'message' && data.message) {
            setChatMessages(prev => [...prev, data.message].slice(-500))
            scrollToBottom()
          }
        } catch {}
      }
      ws.onclose = () => {
        if (closed) return
        reconnectTimer = setTimeout(connect, 2000)
      }
      ws.onerror = () => { try { ws.close() } catch {} }
    }
    connect()
    return () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (chatWsRef.current) { try { chatWsRef.current.close() } catch {} chatWsRef.current = null }
    }
  }, [videoId, isLive])

  if (!videoId) return null

  return (
    <div className="comments-panel">
      <button className="comments-close" onClick={toggleComments}>×</button>
      {isLive ? (
        <div
          className="comments-list"
          ref={chatListRef}
          onScroll={(e) => {
            // Ignore scroll events triggered by our own smooth-scroll animation
            if (Date.now() < programmaticScrollRef.current) return
            const el = e.currentTarget
            // Re-enable stick when the user scrolls back within 40px of the bottom
            stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {chatMessages.length === 0 && <div className="comments-loading">Waiting for messages…</div>}
          {chatMessages.map((m, i) => (
            <div key={i} className="chat-msg">
              <span
                className="chat-author"
                style={{ color: m.isOwner ? 'var(--green)' : m.isMod ? 'var(--blue)' : authorColor(m.author) }}
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
