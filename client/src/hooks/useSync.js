import { useEffect, useRef, useCallback } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'

export function useSync() {
  const wsRef = useRef(null)
  const reconnectTimer = useRef(null)
  const recalibTimer = useRef(null)
  const pingState = useRef({ samples: [], pending: null })

  const connect = useCallback(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws/sync`)
    wsRef.current = ws

    ws.onopen = () => {
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
          usePlaybackStore.getState().update(data)
        } else if (data.type === 'claude') {
          usePlaybackStore.getState().update(data)
        } else if (data.type === 'pong') {
          handlePong(data, ws, pingState.current)
        }
      } catch {}
    }

    ws.onclose = () => {
      useSyncStore.getState().setConnected(false)
      wsRef.current = null
      reconnectTimer.current = setTimeout(connect, 2000)
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

function sendPing(ws, state) {
  if (state.samples.length >= 5) {
    const sorted = [...state.samples].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    useSyncStore.getState().setClockOffset(median)
    console.log(`Clock offset: ${median.toFixed(1)}ms (${state.samples.length} samples)`)
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
