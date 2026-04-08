import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export default function TerminalModal({ onClose }) {
  const termRef = useRef(null)
  const wsRef = useRef(null)
  const xtermRef = useRef(null)

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
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal`)
    wsRef.current = ws

    ws.onopen = () => {
      // Send initial size
      const { cols, rows } = term
      ws.send(`\x01r${cols},${rows}`)
    }
    ws.onmessage = (e) => term.write(e.data)
    ws.onclose = () => term.write('\r\n[disconnected]\r\n')

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(`\x01r${cols},${rows}`)
    })

    const handleResize = () => fitAddon.fit()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      ws.close()
      term.dispose()
    }
  }, [])

  return (
    <div className="terminal-panel">
      <div className="terminal-container" ref={termRef} />
    </div>
  )
}
