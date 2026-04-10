import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useSyncStore } from '../stores/sync'
import '@xterm/xterm/css/xterm.css'

export default function TerminalModal({ onClose, hasNowPlaying, tmuxWindows, visible }) {
  const termRef = useRef(null)
  const wsRef = useRef(null)
  const xtermRef = useRef(null)
  const touchStartXRef = useRef(null)

  useEffect(() => {
    const css = getComputedStyle(document.documentElement)
    const v = (name) => css.getPropertyValue(name).trim()
    const term = new XTerm({
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 14,
      theme: {
        background: v('--bg'),
        foreground: v('--text'),
        cursor: v('--text'),
        cursorAccent: '#151515',
        selectionBackground: v('--surface'),
        selectionForeground: v('--text'),
        black: '#151515',
        red: v('--red'),
        green: '#7e8e50',
        yellow: v('--yellow'),
        blue: v('--blue'),
        magenta: v('--magenta'),
        cyan: v('--cyan'),
        white: v('--text'),
        brightBlack: v('--text-dim'),
        brightRed: v('--red'),
        brightGreen: '#7e8e50',
        brightYellow: v('--yellow'),
        brightBlue: v('--blue'),
        brightMagenta: v('--magenta'),
        brightCyan: v('--cyan'),
        brightWhite: v('--bright-white'),
      },
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 1000,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(termRef.current)
    fitAddon.fit()
    xtermRef.current = term

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const reconnectRef = { current: null }

    function connectWs() {
      const ws = new WebSocket(`${proto}//${location.host}/ws/terminal`)
      wsRef.current = ws

      ws.onopen = () => {
        const { cols, rows } = term
        ws.send(`\x01r${cols},${rows}`)
      }
      ws.onmessage = (e) => term.write(e.data)
      ws.onclose = () => {
        term.write('\r\n[reconnecting...]\r\n')
        reconnectRef.current = setTimeout(connectWs, 500)
      }
      ws.onerror = () => ws.close()

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data)
      })
      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(`\x01r${cols},${rows}`)
      })
    }
    connectWs()

    const handleResize = () => fitAddon.fit()
    window.addEventListener('resize', handleResize)

    // Resize terminal panel when iOS keyboard opens/closes
    const panel = termRef.current?.closest('.terminal-panel')
    const vv = window.visualViewport
    if (vv && panel) {
      const update = () => {
        // visualViewport.height shrinks when keyboard opens
        const totalH = window.innerHeight
        const vvH = vv.height
        const kbH = totalH - vvH
        if (kbH > 100) {
          // Keyboard open: panel fills from top to above keyboard
          panel.style.bottom = `${Math.max(0, kbH - 10)}px`
          panel.style.paddingBottom = '0px'
        } else {
          // Keyboard closed: panel fills to above now-playing bar
          panel.style.bottom = '0px'
          panel.style.paddingBottom = ''
        }
        fitAddon.fit()
      }
      vv.addEventListener('resize', update)
      vv.addEventListener('scroll', update)
    }

    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      window.removeEventListener('resize', handleResize)
      if (wsRef.current) wsRef.current.close()
      term.dispose()
    }
  }, [])

  // Re-focus xterm when terminal becomes visible
  useEffect(() => {
    if (visible && xtermRef.current) xtermRef.current.focus()
  }, [visible])

  const sendKey = (key) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(key)
  }

  // Expose sendKey globally via store so quick-reply buttons work outside terminal
  useEffect(() => {
    useSyncStore.getState().setTerminalSendKey((key) => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) ws.send(key)
    })
    return () => useSyncStore.getState().setTerminalSendKey(null)
  }, [])

  return (
    <div className={`terminal-panel${hasNowPlaying ? '' : ' terminal-full'}`}>
      <div className="terminal-container" ref={termRef} />
      <div className="terminal-keys" onMouseDown={(e) => e.preventDefault()} onTouchStart={(e) => { touchStartXRef.current = e.touches[0].clientX; }} onTouchEnd={(e) => { const dx = Math.abs((e.changedTouches[0]?.clientX || 0) - (touchStartXRef.current || 0)); if (dx > 10) return; e.preventDefault(); const btn = e.target.closest('button'); if (btn) btn.click(); }}>
        <button onClick={() => sendKey('\x01')}>^A</button>
        <button onClick={() => sendKey('\x03')}>^C</button>
        <button onClick={() => sendKey('\x0c')}>^L</button>
        <button onClick={() => sendKey('\x04')}>^D</button>
        <button onClick={() => sendKey('\x1a')}>^Z</button>
        <button onClick={() => sendKey('\x1b')}>esc</button>
        <button onClick={() => sendKey('\t')}>tab</button>
        <button onClick={() => sendKey('\x1b[A')}>↑</button>
        <button onClick={() => sendKey('\x1b[B')}>↓</button>
        <button onClick={() => sendKey('\x1b[C')}>→</button>
        <button onClick={() => sendKey('\x1b[D')}>←</button>
        <button onClick={() => sendKey('\x1b[H')}>home</button>
        <button onClick={() => sendKey('\x1b[F')}>end</button>
        <button onClick={() => sendKey('\x1b[5~')}>pgUp</button>
        <button onClick={() => sendKey('\x1b[6~')}>pgDn</button>
        <button onClick={() => sendKey('|')}>|</button>
        <button onClick={() => sendKey('/')}>/ </button>
        <button onClick={() => sendKey('~')}>~</button>
        <button onClick={async () => { try { const text = await navigator.clipboard.readText(); if (text) sendKey(text); } catch {} }}>paste</button>
      </div>
    </div>
  )
}
