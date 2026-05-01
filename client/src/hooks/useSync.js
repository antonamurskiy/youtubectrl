import { useEffect, useRef, useCallback } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import { isNativeIOS } from '../native/player'

export function useSync() {
  const wsRef = useRef(null)
  const reconnectTimer = useRef(null)
  const recalibTimer = useRef(null)
  const reconnectAttempts = useRef(0)
  const pingState = useRef({ samples: [], pending: null })

  const connect = useCallback(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws/sync`)
    wsRef.current = ws

    ws.onopen = () => {
      reconnectAttempts.current = 0
      useSyncStore.getState().setConnected(true)
      // Start clock offset measurement
      pingState.current = { samples: [], pending: null }
      sendPing(ws, pingState.current)
      // Recalibrate clock offset every 5 minutes
      if (recalibTimer.current) clearInterval(recalibTimer.current)
      recalibTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          pingState.current = { samples: [], pending: null }
          sendPing(ws, pingState.current)
        }
      }, 5 * 60 * 1000)
    }

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.type === 'playback') {
          // Server includes tmuxWindows + tmuxColors on every 1Hz tick.
          // JSON.parse always creates new array/object refs even when
          // contents are identical → useShallow in App sees ref change
          // → App re-renders 1Hz → cascades to all children → typing
          // lag, scrolling jank, etc.
          //
          // Dedupe: replace the new refs with the existing store refs
          // when contents match. App's useShallow then sees no change
          // for those fields and skips the re-render entirely.
          const cur = usePlaybackStore.getState()
          if (data.tmuxWindows && shallowEqualWindows(data.tmuxWindows, cur.tmuxWindows)) {
            data.tmuxWindows = cur.tmuxWindows
          }
          if (data.tmuxColors && shallowEqualMap(data.tmuxColors, cur.tmuxColors)) {
            data.tmuxColors = cur.tmuxColors
          }
          // In phone-only native mode, the AVPlayer is authoritative for
          // position/duration/paused. Don't let mpv's WS broadcast overwrite
          // them (mpv is muted+hidden there but still reports stale state).
          const phoneOnly = !!useSyncStore.getState().phoneOnlyUrl
          if (isNativeIOS && phoneOnly) {
            const { position, duration, paused, ...rest } = data
            usePlaybackStore.getState().update(rest)
          } else {
            usePlaybackStore.getState().update(data)
          }
        } else if (data.type === 'claude') {
          usePlaybackStore.getState().update(data)
        } else if (data.type === 'tmux') {
          // Focused update from /api/tmux-select / rename / color save —
          // refresh the tab bar without waiting for the next 1Hz tick.
          const cur = usePlaybackStore.getState()
          const update = {}
          if (!shallowEqualWindows(data.tmuxWindows, cur.tmuxWindows)) {
            update.tmuxWindows = data.tmuxWindows
          }
          if (data.tmuxColors && !shallowEqualMap(data.tmuxColors, cur.tmuxColors)) {
            update.tmuxColors = data.tmuxColors
          }
          if (Object.keys(update).length) usePlaybackStore.getState().update(update)
        } else if (data.type === 'claude-feed') {
          if (Array.isArray(data.lines) && data.lines.length) {
            useSyncStore.getState().pushClaudeFeed(data.lines)
          }
        } else if (data.type === 'pong') {
          handlePong(data, ws, pingState.current)
        }
      } catch {}
    }

    ws.onclose = () => {
      useSyncStore.getState().setConnected(false)
      wsRef.current = null
      // Exponential backoff: 500ms, 1s, 2s, 4s, 8s, 16s, cap at 30s
      const attempt = Math.min(reconnectAttempts.current, 6)
      const delay = Math.min(500 * Math.pow(2, attempt), 30000)
      reconnectAttempts.current++
      reconnectTimer.current = setTimeout(connect, delay)
    }

    ws.onerror = () => ws.close()
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (recalibTimer.current) clearInterval(recalibTimer.current)
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (wsRef.current) wsRef.current.close()
    }
  }, [connect])

  const send = useCallback((msg) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  return { send, wsRef }
}

// Shallow content equality for the tmuxWindows array. Each window is
// compared by the fields the UI actually reads (index, name, active,
// title). Adding fields on the server requires adding them here.
function shallowEqualWindows(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (x === y) continue
    if (!x || !y) return false
    if (x.index !== y.index || x.name !== y.name || x.active !== y.active || x.title !== y.title) return false
  }
  return true
}

// Shallow content equality for tmuxColors: { name: hex, ... }
function shallowEqualMap(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const ak = Object.keys(a), bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}

function sendPing(ws, state) {
  if (state.samples.length >= 5) {
    const sorted = [...state.samples].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    useSyncStore.getState().setClockOffset(median)
    return
  }
  if (ws.readyState !== WebSocket.OPEN) return
  state.pending = Date.now()
  ws.send(JSON.stringify({ type: 'ping', clientTs: state.pending }))
}

function handlePong(data, ws, state) {
  if (!state.pending) return
  const now = Date.now()
  const rtt = now - state.pending
  const offset = data.serverTs - state.pending - rtt / 2
  state.samples.push(offset)
  state.pending = null
  setTimeout(() => sendPing(ws, state), 50)
}
