import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { useSyncStore } from '../stores/sync'
import { usePlaybackStore } from '../stores/playback'
import { currentFont, currentFontSize, FONTS } from '../fonts'
import { NativePlayer } from '../native/player'
import '@xterm/xterm/css/xterm.css'

// xterm needs a plain family string like "'JetBrains Mono', monospace"
function xtermFontFamily() {
  const label = currentFont()
  const entry = FONTS.find(f => f[0] === label) || FONTS[0]
  return entry[1]
}

// Multiply each RGB channel by `factor` so a small swatch on a dark
// modal bg matches the perceived darkness when the same hex is
// stretched across the entire terminal pane (large filled regions
// read brighter than tiny ones — Helmholtz-Kohlrausch). Mirrors the
// helper in App.jsx that's applied at the tab.
function darkenHex(hex, factor = 0.55) {
  if (!hex) return hex
  const c = hex.replace('#', '')
  const h = c.length === 3 ? c.split('').map(x => x + x).join('') : c.slice(0, 6)
  const r = Math.round(parseInt(h.slice(0, 2), 16) * factor)
  const g = Math.round(parseInt(h.slice(2, 4), 16) * factor)
  const b = Math.round(parseInt(h.slice(4, 6), 16) * factor)
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')
}

// Mix `color` (hex) toward `base` so the terminal bg gets a subtle tint
// without going neon. mix = fraction of color in the result.
function mixHex(color, base, mix) {
  if (!color) return base
  const c = color.replace('#', '')
  const h = c.length === 3 ? c.split('').map(x => x + x).join('') : c.slice(0, 6)
  const bh = base.replace('#', '').padEnd(6, '0').slice(0, 6)
  const cr = parseInt(h.slice(0, 2), 16), cg = parseInt(h.slice(2, 4), 16), cb = parseInt(h.slice(4, 6), 16)
  const br = parseInt(bh.slice(0, 2), 16), bg = parseInt(bh.slice(2, 4), 16), bb = parseInt(bh.slice(4, 6), 16)
  const r = Math.round(br + (cr - br) * mix)
  const g = Math.round(bg + (cg - bg) * mix)
  const b = Math.round(bb + (cb - bb) * mix)
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}

export default function TerminalModal({ onClose, hasNowPlaying, tmuxWindows, tmuxColors, visible }) {
  const termRef = useRef(null)
  const wsRef = useRef(null)
  const xtermRef = useRef(null)
  const fitAddonRef = useRef(null)
  const touchStartXRef = useRef(null)
  // Pane-swipe state. Captures start coords + time on touchstart;
  // touchend reads tmuxWindows from the latest render via a ref so
  // the handler doesn't go stale between window changes.
  const swipeStartRef = useRef(null)
  const scrollZoneRef = useRef(null)
  // Set when the most recent touchend was a horizontal pane-swipe.
  // refocusOnTap reads this and skips refocus so the iOS soft keyboard
  // doesn't pop up every time the user swipes between tmux windows.
  const justSwipedRef = useRef(false)
  const tmuxWindowsRef = useRef(tmuxWindows)
  useEffect(() => { tmuxWindowsRef.current = tmuxWindows }, [tmuxWindows])

  // Active window's tint colour, looked up by name in the color map.
  // null/undefined = no tint (default theme bg).
  const activeWindow = Array.isArray(tmuxWindows) ? tmuxWindows.find(w => w.active) : null
  const activeColor = activeWindow && tmuxColors ? tmuxColors[activeWindow.name] : null
  const activeColorRef = useRef(activeColor)
  useEffect(() => { activeColorRef.current = activeColor }, [activeColor])

  // Switch to the tmux window N positions away from the active one.
  // Wraps around the list. Optimistically flips the active flag in
  // the playback store before the server confirms — without that,
  // the tab bar lags ~500ms behind the swipe.
  const switchTmuxByOffset = (delta) => {
    const list = tmuxWindowsRef.current
    if (!Array.isArray(list) || list.length < 2) return
    const activeIdx = list.findIndex(w => w.active)
    if (activeIdx < 0) return
    const next = list[(activeIdx + delta + list.length) % list.length]
    if (!next) return
    // Optimistic local update — server will follow with an authoritative
    // {type:'tmux'} broadcast once tmux confirms the select.
    usePlaybackStore.getState().update({
      tmuxWindows: list.map(w => ({ ...w, active: w.index === next.index })),
    })
    fetch('/api/tmux-select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: next.index }),
    }).catch(() => {})
  }

  const onPaneTouchStart = (e) => {
    // Only single-finger swipes count — two-finger touches are
    // xterm scrolling / pinch zoom and shouldn't switch windows.
    if (e.touches.length !== 1) { swipeStartRef.current = null; return }
    const t = e.touches[0]
    swipeStartRef.current = { x: t.clientX, y: t.clientY, at: Date.now() }
  }
  const onPaneTouchEnd = (e) => {
    const start = swipeStartRef.current
    swipeStartRef.current = null
    if (!start) return
    const t = e.changedTouches[0]
    if (!t) return
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    const dt = Date.now() - start.at
    // Heuristic for "horizontal swipe": ≥80px traveled, dominated
    // by horizontal motion (>1.5x vertical), under 500ms. Keeps
    // ordinary taps and vertical scrolls from triggering switches.
    if (dt > 500) return
    if (Math.abs(dx) < 80) return
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return
    // preventDefault so iOS Safari doesn't synthesize a
    // mousedown/mouseup pair from this touch. xterm's mouse reporter
    // would otherwise compute NaN cell coords for the synthetic
    // event during the layout shift caused by the optimistic tab
    // update, encode them as `\x1b[<NaN>;<NaN>;<NaN>M`, and pipe
    // those bytes into the tmux pane — they show up as the random
    // `aN;NaNM`-style strings in Claude's prompt input.
    if (e.cancelable) e.preventDefault()
    // Swipe LEFT (finger moves left, dx<0) advances to next pane —
    // matches the iOS Safari tab-swipe convention.
    justSwipedRef.current = true
    setTimeout(() => { justSwipedRef.current = false }, 400)
    switchTmuxByOffset(dx < 0 ? 1 : -1)
  }

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
      // If the active tmux window has a chosen color, blend it into the
      // base bg so the terminal pane visibly reflects which window is
      // focused.
      const baseBg = v('--bg') || '#282828'
      const tintBg = activeColorRef.current ? darkenHex(activeColorRef.current) : baseBg
      return {
        background: tintBg,
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
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)
    term.open(termRef.current)
    fitAddon.fit()

    // iOS + WebGL renderer: the canvas overlays the hidden xterm-helper-textarea,
    // so after the keyboard dismisses, a tap on the canvas doesn't land on the
    // textarea and iOS won't resummon the keyboard. Explicitly refocus on tap.
    const termEl = termRef.current

    // xterm's WebGL renderer keeps the .xterm-viewport div scrollable
    // (it syncs scrollTop to the buffer position). External CSS
    // !important doesn't always beat the styles xterm sets inline +
    // scroll handlers attached at the renderer level. Forcefully
    // remove ALL touch-driven scroll capabilities by setting inline
    // !important properties via JS:
    //   touch-action: none      → browser doesn't generate scroll
    //   overflow: hidden        → scrollTop has no effect
    //   pointer-events: none    → touches pass through to terminal-
    //                              container (swipe detection) or our
    //                              right-edge .terminal-scroll-zone
    //                              overlay (explicit scroll).
    // MutationObserver re-applies in case xterm re-creates internal
    // nodes on resize/theme change.
    // The actual cause of "I can scroll anywhere" was tmux's mouse mode:
    // xterm forwards touch-drag events as mouse escape sequences to the
    // pty, and tmux interprets them as scroll-back commands. Disabling
    // CSS scroll on .xterm-viewport doesn't help because the scroll is
    // happening INSIDE tmux, not in the browser.
    //
    // Fix: hard-disable pointer events on the entire xterm subtree so
    // touches never reach xterm's mouse reporter. The terminal-
    // container parent still receives touch events for swipe detection,
    // and refocusOnTap continues to work because it listens on termEl
    // (the parent) — touches that pass THROUGH the xterm canvas reach
    // termEl thanks to pointer-events: none on the children. The
    // right-edge .terminal-scroll-zone overlay sits on TOP and handles
    // explicit scroll via xterm.scrollLines().
    const lockSubtree = () => {
      const xterm = termEl.querySelector('.xterm')
      if (!xterm) return
      xterm.style.setProperty('pointer-events', 'none', 'important')
      // Also lock viewport just in case browser ever generates scroll.
      const v = termEl.querySelector('.xterm-viewport')
      if (v) {
        v.style.setProperty('touch-action', 'none', 'important')
        v.style.setProperty('overflow', 'hidden', 'important')
      }
    }
    lockSubtree()
    const viewportLockObserver = new MutationObserver(lockSubtree)
    viewportLockObserver.observe(termEl, { childList: true, subtree: true })
    // Track touch coords inside the same listener pair as refocusOnTap
    // so we can decide BEFORE the React-side onTouchEnd has run whether
    // the gesture was a horizontal pane-swipe. (justSwipedRef alone
    // didn't help — the native touchend listener fires before React's
    // delegated handler, so the swipe ref hadn't been set yet when
    // refocusOnTap ran, and the iOS keyboard popped on every swipe.)
    //
    // tapStartRef tracks tap geometry so refocusOnTap can ignore swipe-
    // length / long-hold gestures and not pop the iOS keyboard when
    // the user swipes between panes.
    const tapStartRef = { x: 0, y: 0, at: 0 }
    const onTermTouchStart = (e) => {
      if (!e.touches || e.touches.length !== 1) { tapStartRef.at = 0; return }
      const t = e.touches[0]
      tapStartRef.x = t.clientX; tapStartRef.y = t.clientY; tapStartRef.at = Date.now()
    }
    const refocusOnTap = (e) => {
      // Skip when the touchend was a horizontal pane-swipe / long-hold.
      if (e?.changedTouches?.length) {
        const t = e.changedTouches[0]
        const dx = Math.abs(t.clientX - tapStartRef.x)
        const dy = Math.abs(t.clientY - tapStartRef.y)
        const dt = Date.now() - tapStartRef.at
        if (dx > 12 || dy > 12 || dt > 500) return
      }
      if (justSwipedRef.current) return
      const ta = termEl?.querySelector('.xterm-helper-textarea')
      if (ta) ta.focus()
      else term.focus()
    }
    termEl.addEventListener('touchstart', onTermTouchStart, { passive: true })
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
        // Drop CSI escape sequences containing literal "NaN" before
        // they reach the pty. xterm's mouse reporter sometimes
        // computes pixel→cell coords against a zero/stale cellWidth
        // and emits sequences like `\x1b[<NaN;NaN;NaNM`; if those
        // hit tmux/Claude Code, partial bytes show up as typed
        // input ("aN;NaNM" garbage in the chat box). The regex
        // matches a CSI introducer + body + a letter terminator
        // where the body literally contains the string "NaN".
        const cleaned = data.replace(/\x1b\[[^a-zA-Z]*NaN[^a-zA-Z]*[a-zA-Z]/g, '')
        if (cleaned && ws.readyState === WebSocket.OPEN) ws.send(cleaned)
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
      viewportLockObserver.disconnect()
      termEl?.removeEventListener('touchstart', onTermTouchStart)
      termEl?.removeEventListener('touchend', refocusOnTap)
      termEl?.removeEventListener('mousedown', refocusOnTap)
      if (wsRef.current) wsRef.current.close()
      try { webgl?.dispose() } catch {}
      term.dispose()
    }
  }, [])

  // Whenever the active tmux window changes (swipe, tab tap, native
  // tmux key bind), pin xterm to the bottom for 1.2s. Swipes are easy
  // to mis-aim into a vertical scroll. xterm's WebGL renderer eats
  // touch/wheel events directly so preventDefault on touchmove alone
  // doesn't cover everything — pin via setInterval(20ms) instead of
  // rAF so even mid-frame scrollback shifts get yanked back. Lock is
  // also extended on every active touch (see onTermTouchMove) so a
  // slow swipe doesn't escape the original window.
  const activeIdx = activeWindow?.index
  const scrollLockUntilRef = useRef(0)
  // Persistent pin loop — checks the lock deadline every 20ms and
  // calls scrollToBottom whenever inside the window. Lives for the
  // lifetime of the terminal so touchmove handlers can extend the
  // deadline without having to restart the interval.
  useEffect(() => {
    const iv = setInterval(() => {
      const term = xtermRef.current
      if (!term) return
      // Don't fight an active scroll-zone gesture — the user is
      // explicitly trying to move the buffer and the pin loop kept
      // yanking them back to bottom mid-swipe.
      if (scrollZoneRef.current) return
      if (Date.now() < scrollLockUntilRef.current) {
        try { term.scrollToBottom() } catch {}
      }
    }, 20)
    return () => clearInterval(iv)
  }, [])
  useEffect(() => {
    scrollLockUntilRef.current = Date.now() + 1200
  }, [activeIdx])

  // xterm's WebGL theme.background snaps when assigned. To match the
  // body's 400ms ease CSS fade, animate the xterm bg manually via
  // requestAnimationFrame interpolating from the previous color to
  // the new one with the same cubic-bezier(0.25, 0.1, 0.25, 1) curve.
  // Without this, xterm visibly snapped to the new tint while body
  // was still fading — exactly the "Dynamic Island late" perception.
  const xtermBgRef = useRef(null)
  useEffect(() => {
    const term = xtermRef.current
    if (!term) return
    const css = getComputedStyle(document.body)
    const baseBg = css.getPropertyValue('--bg').trim() || '#282828'
    const target = activeColor ? darkenHex(activeColor) : baseBg
    const from = xtermBgRef.current || target
    xtermBgRef.current = target
    const parse = (hex) => {
      const c = hex.replace('#', '')
      const h = c.length === 3 ? c.split('').map(x => x + x).join('') : c.slice(0, 6)
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    }
    const [fr, fg, fb] = parse(from)
    const [tr, tg, tb] = parse(target)
    if (fr === tr && fg === tg && fb === tb) {
      try { term.options.theme = { ...term.options.theme, background: target }; term.refresh(0, term.rows - 1) } catch {}
      return
    }
    // Cubic bezier evaluator for cubic-bezier(0.25, 0.1, 0.25, 1) —
    // matches CSS `ease`. Newton-Raphson on x to find t.
    const bz = (t, p1, p2) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t
    const easeY = (x) => {
      let t = x
      for (let i = 0; i < 6; i++) {
        const xt = bz(t, 0.25, 0.25)
        const dx = 3 * (1 - t) * (1 - t) * 0.25 + 6 * (1 - t) * t * (0.25 - 0.25) + 3 * t * t * (1 - 0.25)
        t -= (xt - x) / (dx || 1)
      }
      return bz(t, 0.1, 1)
    }
    const start = performance.now()
    const dur = 400
    let raf = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      const elapsed = performance.now() - start
      const x = Math.min(1, elapsed / dur)
      const e = easeY(x)
      const r = Math.round(fr + (tr - fr) * e)
      const g = Math.round(fg + (tg - fg) * e)
      const b = Math.round(fb + (tb - fb) * e)
      const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
      try {
        term.options.theme = { ...term.options.theme, background: hex }
        term.refresh(0, term.rows - 1)
      } catch {}
      if (x < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelled = true; cancelAnimationFrame(raf) }
  }, [activeColor])

  // Paint the iOS safe-area regions (top under the Dynamic Island,
  // bottom under the keyboard) with the same tint by setting
  // body+html backgrounds. Tabs strip + panel background already
  // reflect the tint, but the safe-area gutters bleed through to
  // the document root, leaving them gray. Restored on close.
  useEffect(() => {
    if (!visible) return
    const html = document.documentElement
    const body = document.body
    const prevHtml = html.style.background
    const prevBody = body.style.background
    const baseBg = getComputedStyle(body).getPropertyValue('--bg').trim() || '#282828'
    const tintBg = activeColor ? darkenHex(activeColor) : baseBg
    // overlaysWebView is permanently true in capacitor.config.json so
    // body always extends behind the Dynamic Island. The gutter is
    // driven by body's CSS transition (400ms ease). Native call just
    // snaps the WebView/UIWindow bg so it matches when the fade ends
    // — body covers them during the fade so the snap is invisible.
    // Toggling overlay at runtime caused a ~50ms gutter-late seam
    // because the WebView-frame relayout took longer than the body
    // bg flip.
    // CSS rules in App.css carry the 400ms cubic-bezier transitions
    // for body + html. Just set the bg here — the rule fires the fade.
    html.style.background = tintBg
    body.style.background = tintBg
    NativePlayer.setSafeAreaBackground?.(tintBg)?.catch?.(() => {})
    return () => {
      html.style.background = prevHtml
      body.style.background = prevBody
      NativePlayer.setSafeAreaBackground?.('')?.catch?.(() => {})
    }
  }, [visible, activeColor])

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

  // Same tint applied to panel chrome (xterm-viewport CSS reads this
  // var so the bg matches the renderer-painted area exactly).
  // Shortcut keys (^A/^C/etc.) draw a translucent overlay on top of
  // the panel bg so they stay in the same color family.
  const panelBg = activeColor ? darkenHex(activeColor) : null
  const panelStyle = panelBg
    ? {
        background: panelBg,
        '--terminal-bg': panelBg,
        '--terminal-key-bg': 'rgba(255,255,255,0.07)',
        '--terminal-key-bg-active': 'rgba(255,255,255,0.14)',
      }
    : undefined
  return (
    <div
      className={`terminal-panel${hasNowPlaying ? '' : ' terminal-full'}`}
      style={panelStyle}
    >
      <div
        className="terminal-container"
        ref={termRef}
        onTouchStart={onPaneTouchStart}
        onTouchEnd={onPaneTouchEnd}
        onTouchCancel={() => { swipeStartRef.current = null }}
      />
      <div
        className="terminal-scroll-zone"
        aria-hidden="true"
        onTouchStart={(e) => {
          const t = e.touches[0]
          if (!t) return
          scrollZoneRef.current = { y: t.clientY, lastY: t.clientY }
        }}
        onTouchMove={(e) => {
          const s = scrollZoneRef.current
          if (!s) return
          const t = e.touches[0]
          if (!t) return
          const term = xtermRef.current
          if (!term) return
          const rect = term.element?.getBoundingClientRect()
          const rowH = (rect && term.rows) ? rect.height / term.rows : 18
          const dyPx = t.clientY - s.lastY
          const lines = Math.trunc(-dyPx / rowH)
          if (lines !== 0) {
            // tmux's mouse mode is on, so the visible scroll buffer
            // lives inside tmux (not xterm's local scrollback —
            // tmux's alt-screen never fills it). Send mouse-wheel
            // escape sequences so tmux scrolls its own copy-mode
            // buffer like a real wheel scroll would. SGR mouse wheel:
            //   up   = `\x1b[<64;X;YM`
            //   down = `\x1b[<65;X;YM`
            const ws = wsRef.current
            if (ws?.readyState === WebSocket.OPEN) {
              const cb = lines > 0 ? 65 : 64
              const count = Math.min(Math.abs(lines), 8)
              const cx = Math.max(1, term.cols - 2)
              const cy = Math.max(1, Math.floor(term.rows / 2))
              const seq = `\x1b[<${cb};${cx};${cy}M`
              for (let i = 0; i < count; i++) ws.send(seq)
            }
            // Also nudge xterm's local scrollback in case mouse mode
            // is off in the current tmux pane (Claude prompt etc.).
            try { term.scrollLines(lines) } catch {}
            s.lastY = s.lastY - lines * rowH
          }
        }}
        onTouchEnd={() => {
          scrollZoneRef.current = null
          // Mouse-wheel sequences leave tmux in copy-mode (the user
          // is "stuck" — typing doesn't reach the prompt anymore).
          // Cancel automatically on lift-off; no-op if not in a mode.
          fetch('/api/tmux-cancel-copy-mode', { method: 'POST' }).catch(() => {})
        }}
        onTouchCancel={() => {
          scrollZoneRef.current = null
          fetch('/api/tmux-cancel-copy-mode', { method: 'POST' }).catch(() => {})
        }}
      />
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
