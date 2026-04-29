import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { useSyncStore } from '../stores/sync'
import { currentFont, currentFontSize, FONTS } from '../fonts'
import '@xterm/xterm/css/xterm.css'

// xterm needs a plain family string like "'JetBrains Mono', monospace"
function xtermFontFamily() {
  const label = currentFont()
  const entry = FONTS.find(f => f[0] === label) || FONTS[0]
  return entry[1]
}

export default function TerminalModal({ onClose, hasNowPlaying, tmuxWindows, visible }) {
  const termRef = useRef(null)
  const wsRef = useRef(null)
  const xtermRef = useRef(null)
  const touchStartXRef = useRef(null)

  useEffect(() => {
    // Read the current palette out of CSS vars. Called both at terminal
    // creation and whenever body.maria-proximity flips, so the xterm
    // theme stays in sync with the rest of the UI's theme override.
    const buildTheme = () => {
      // Read from body, not documentElement — the proximity overrides
      // are scoped to body.maria-proximity, and CSS custom properties
      // don't bubble up. Reading from html silently gave the default
      // gruvbox palette regardless of class state.
      const css = getComputedStyle(document.body)
      const v = (name) => css.getPropertyValue(name).trim()
      const proximity = document.body.classList.contains('maria-proximity')
      // Green has no CSS var (hardcoded olive in default theme); during
      // proximity, swap to a peach that harmonizes with the red wash.
      const green = proximity ? '#d49b7e' : '#7e8e50'
      return {
        background: v('--bg'),
        foreground: v('--text'),
        cursor: v('--text'),
        cursorAccent: proximity ? '#2a0606' : '#151515',
        selectionBackground: v('--surface'),
        selectionForeground: v('--text'),
        black: proximity ? '#2a0606' : '#151515',
        red: v('--red'),
        green,
        yellow: v('--yellow'),
        blue: v('--blue'),
        magenta: v('--magenta'),
        cyan: v('--cyan'),
        white: v('--text'),
        brightBlack: v('--text-dim'),
        brightRed: v('--red'),
        brightGreen: green,
        brightYellow: v('--yellow'),
        brightBlue: v('--blue'),
        brightMagenta: v('--magenta'),
        brightCyan: v('--cyan'),
        brightWhite: v('--bright-white'),
      }
    }
    const term = new XTerm({
      fontFamily: xtermFontFamily(),
      fontSize: currentFontSize(),
      theme: buildTheme(),
      cursorBlink: false,
      allowProposedApi: true,
      scrollback: 1000,
    })
    // Re-apply the theme whenever maria-proximity toggles. xterm
    // accepts a fresh theme object via term.options.theme — the
    // active renderer (WebGL or DOM) repaints with the new palette.
    const proximityObserver = new MutationObserver(() => {
      try {
        term.options.theme = buildTheme()
        // WebGL renderer caches the glyph atlas keyed on the theme;
        // refresh forces it to repaint visible cells with the new
        // colors instead of holding the previous palette until scroll.
        term.refresh(0, term.rows - 1)
      } catch {}
    })
    proximityObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(termRef.current)
    fitAddon.fit()

    // iOS + WebGL renderer: the canvas overlays the hidden xterm-helper-textarea,
    // so after the keyboard dismisses, a tap on the canvas doesn't land on the
    // textarea and iOS won't resummon the keyboard. Explicitly refocus on tap.
    const termEl = termRef.current
    const refocusOnTap = () => {
      const ta = termEl?.querySelector('.xterm-helper-textarea')
      if (ta) ta.focus()
      else term.focus()
    }
    termEl.addEventListener('touchend', refocusOnTap)
    termEl.addEventListener('mousedown', refocusOnTap)

    // GPU-accelerated rendering. Must load after open(). If WebGL init
    // fails (old device, context exhausted) or the context is lost later,
    // xterm silently falls back to the canvas/DOM renderer.
    let webgl = null
    try {
      webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        console.warn('[terminal] WebGL context lost, falling back')
        try { webgl.dispose() } catch {}
      })
      term.loadAddon(webgl)
      console.log('[terminal] WebGL renderer active')
    } catch (e) {
      console.warn('[terminal] WebGL addon failed, using DOM renderer:', e)
    }

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

    const handleFontChange = () => {
      try {
        term.options.fontFamily = xtermFontFamily()
        term.options.fontSize = currentFontSize()
        fitAddon.fit()
      } catch {}
    }
    window.addEventListener('app-font-change', handleFontChange)

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
      proximityObserver.disconnect()
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('app-font-change', handleFontChange)
      termEl?.removeEventListener('touchend', refocusOnTap)
      termEl?.removeEventListener('mousedown', refocusOnTap)
      if (wsRef.current) wsRef.current.close()
      try { webgl?.dispose() } catch {}
      term.dispose()
    }
  }, [])

  // Refocus xterm on reopen ONLY if the iOS keyboard was up at the
  // moment we last closed the terminal. Focusing the xterm helper
  // textarea on iOS forces the soft keyboard up — annoying when the
  // user closed terminal specifically to dismiss it.
  const wasKbOpenAtCloseRef = useRef(false)
  const prevVisibleRef = useRef(false)
  useEffect(() => {
    const wasVisible = prevVisibleRef.current
    prevVisibleRef.current = visible
    if (wasVisible && !visible) {
      const vv = window.visualViewport
      const kbH = vv ? window.innerHeight - vv.height : 0
      wasKbOpenAtCloseRef.current = kbH > 100
    } else if (!wasVisible && visible && wasKbOpenAtCloseRef.current) {
      if (xtermRef.current) xtermRef.current.focus()
    }
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
        <button onClick={() => sendKey('\x02')}>^B</button>
        <button onClick={() => sendKey('\x03')}>^C</button>
        <button onClick={() => sendKey('\x0c')}>^L</button>
        <button onClick={() => sendKey('\x04')}>^D</button>
        <button onClick={() => sendKey('\x0f')}>^O</button>
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
