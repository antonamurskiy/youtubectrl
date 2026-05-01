import { useEffect, useRef, useState, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { flushSync, createPortal } from 'react-dom'
import { tick as hapticTick, thump as hapticThump } from './haptics'
import { useSync } from './hooks/useSync'
import { useMediaSession } from './hooks/useMediaSession'
import { useNativeNowPlaying } from './hooks/useNativeNowPlaying'
import { usePushTap } from './hooks/usePushTap'
import { usePullToRefresh } from './hooks/usePullToRefresh'
import { useVolumeButtons } from './hooks/useVolumeButtons'
import { useMariaProximity } from './hooks/useMariaProximity'
import { isNativeIOS, NativePlayer } from './native/player'
import { useUIStore } from './stores/ui'
import { usePlaybackStore } from './stores/playback'
import { useSyncStore } from './stores/sync'
import VideoGrid from './components/VideoGrid'
import NowPlayingBar from './components/NowPlayingBar'
import SecretMenu from './components/SecretMenu'
import CommentsPanel from './components/CommentsPanel'
import SearchBar from './components/SearchBar'
import VolumeHud from './components/VolumeHud'
import { useRouting } from './hooks/useRouting'
import Toast from './components/Toast'
import ClaudeFeed from './components/ClaudeFeed'
import { lazy, Suspense } from 'react'
const Terminal = lazy(() => import('./components/Terminal'))
const PhonePlayer = lazy(() => import('./components/PhonePlayer'))
import './App.css'

// Palette for tmux-window background tinting. First entry clears the
// assignment. Hex picks are gruvbox-aligned so they harmonize with the
// rest of the theme.
// Multiply each RGB channel by `factor` so a small swatch on a dark
// modal bg matches the perceived darkness when the same hex is
// stretched across a tab + full-screen terminal area (large filled
// regions read brighter than tiny ones — Helmholtz-Kohlrausch).
// Exported so the Terminal can use the same darken on its bg.
export function darkenHex(hex, factor = 0.55) {
  if (!hex) return hex
  const c = hex.replace('#', '')
  const h = c.length === 3 ? c.split('').map(x => x + x).join('') : c.slice(0, 6)
  const r = Math.round(parseInt(h.slice(0, 2), 16) * factor)
  const g = Math.round(parseInt(h.slice(2, 4), 16) * factor)
  const b = Math.round(parseInt(h.slice(4, 6), 16) * factor)
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')
}

// Lighten a hex toward white. mix=0 returns the input, 1 returns white.
function brightenHex(hex, mix) {
  if (!hex) return hex
  const c = hex.replace('#', '')
  const h = c.length === 3 ? c.split('').map(x => x + x).join('') : c.slice(0, 6)
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const lr = Math.round(r + (255 - r) * mix)
  const lg = Math.round(g + (255 - g) * mix)
  const lb = Math.round(b + (255 - b) * mix)
  return '#' + [lr, lg, lb].map(v => v.toString(16).padStart(2, '0')).join('')
}

const TMUX_COLOR_SWATCHES = [
  { value: '', label: 'clear' },
  // ── Dim row ────────────────────────────────────────────────
  { value: '#5a1f1c', label: 'red' },
  { value: '#3a1414', label: 'maroon' },
  { value: '#5a2828', label: 'brick' },
  { value: '#5e3414', label: 'orange' },
  { value: '#4a2810', label: 'rust' },
  { value: '#3d2a1c', label: 'brown' },
  { value: '#5c4416', label: 'amber' },
  { value: '#4a4416', label: 'olive' },
  { value: '#3f4416', label: 'green' },
  { value: '#2c3812', label: 'moss' },
  { value: '#1f3d24', label: 'forest' },
  { value: '#2e4a3a', label: 'teal' },
  { value: '#1c4548', label: 'cyan' },
  { value: '#1f3d49', label: 'blue' },
  { value: '#1c2c4a', label: 'navy' },
  { value: '#2c2e4a', label: 'indigo' },
  { value: '#3a2647', label: 'violet' },
  { value: '#4a2e44', label: 'purple' },
  { value: '#4a2438', label: 'plum' },
  { value: '#4a2030', label: 'wine' },
  { value: '#2a2a2a', label: 'graphite' },
  { value: '#3a342e', label: 'taupe' },
  { value: '#2e3438', label: 'slate' },
  // ── Brighter (gruvbox medium-ish, more saturated but not neon) ──
  { value: '#a13a36', label: 'red+' },
  { value: '#b85e22', label: 'orange+' },
  { value: '#c58a25', label: 'amber+' },
  { value: '#7a8a30', label: 'olive+' },
  { value: '#4f8a5c', label: 'green+' },
  { value: '#3f8a8c', label: 'teal+' },
  { value: '#3f7099', label: 'blue+' },
  { value: '#5a5fa3', label: 'indigo+' },
  { value: '#8a5a96', label: 'purple+' },
  { value: '#a05680', label: 'plum+' },
  { value: '#7a5a4a', label: 'mocha+' },
  { value: '#6a6a6a', label: 'graphite+' },
]

function TmuxTabButton({ window: w, color }) {
  const pressStartRef = useRef(0)
  const inputRef = useRef(null)
  const containerRef = useRef(null)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(w.name)
  // Local pending color while editing — committed alongside the rename
  // so the new name immediately picks up the chosen tint.
  const [pendingColor, setPendingColor] = useState(color || '')

  // Snapshot of the original color taken when editing begins. Used
  // to revert the optimistic preview if the user cancels.
  const originalColorRef = useRef(color || '')

  // Apply a swatch to the live store immediately so the whole app
  // (terminal, body, gutter, tabs, FAB, now-playing) previews the
  // pick without requiring the user to commit first. Writes to a
  // dedicated `tmuxColorPreview` map (read first, fallback to
  // tmuxColors) so the 1Hz server WS broadcast doesn't overwrite
  // the optimistic value mid-preview. Cleared on commit / cancel.
  const setLivePreview = (hex) => {
    const cur = usePlaybackStore.getState().tmuxColorPreview || {}
    const next = { ...cur }
    if (hex) next[w.name] = hex
    else next[w.name] = ''  // explicit clear (distinct from absent)
    usePlaybackStore.getState().update({ tmuxColorPreview: next })
  }
  const clearLivePreview = () => {
    const cur = usePlaybackStore.getState().tmuxColorPreview || {}
    if (!(w.name in cur)) return
    const next = { ...cur }
    delete next[w.name]
    usePlaybackStore.getState().update({ tmuxColorPreview: next })
  }

  const commit = () => {
    const next = value.trim()
    const renamed = next && next !== w.name
    const colorChanged = (pendingColor || '') !== (originalColorRef.current || '')
    if (renamed) {
      fetch('/api/tmux-rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: w.index, name: next }) }).catch(() => {})
    }
    if (colorChanged || renamed) {
      const targetName = renamed ? next : w.name
      fetch('/api/tmux-color', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: targetName, color: pendingColor || null }) }).catch(() => {})
    }
    // Drop the preview override; once the server's broadcast lands
    // tmuxColors will hold the new value.
    clearLivePreview()
    setEditing(false)
  }
  const cancel = () => {
    clearLivePreview()
    setValue(w.name)
    setPendingColor(originalColorRef.current || '')
    setEditing(false)
  }

  const enterEdit = () => {
    hapticTick()
    originalColorRef.current = color || ''
    setValue(w.name)
    setPendingColor(color || '')
    flushSync(() => setEditing(true))
    // Defer focus to the next event-loop tick. flushSync mounts the
    // portal synchronously but iOS hasn't laid it out yet, and
    // focus() on a not-yet-laid-out input was getting silently
    // dropped — modal showed, keyboard never came up, user couldn't
    // type. Two-step: rAF for layout, setTimeout(0) to escape any
    // remaining gesture-handler stack frame so iOS still treats this
    // as in-gesture for keyboard activation.
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      try {
        const len = el.value.length
        el.setSelectionRange(len, len)
      } catch {}
    })
  }

  const handleEnd = (e) => {
    const dur = Date.now() - pressStartRef.current
    pressStartRef.current = 0
    if (dur >= 500) {
      e.preventDefault()
      e.stopPropagation()
      enterEdit()
    } else {
      e.stopPropagation()
      fetch('/api/tmux-select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: w.index }) }).catch(() => {})
    }
  }

  // No outside-tap dismiss: on iOS, focusing the input animates the
  // keyboard open which synthesizes pointer events outside the popover
  // and was killing it. Instead the user dismisses explicitly via the
  // ok button, Enter, or Escape (cancel).

  // Tinting: chosen color → translucent fill so dimmed text stays
  // readable. Active window: keep the tab bg identical to inactive
  // tabs (so all tabs share one shade) and signal the active state
  // with a brightened-color border + text only.
  const tintBg = color ? darkenHex(color) : undefined
  return (
    <>
      <button
        style={{
          ...(tintBg ? { background: tintBg } : null),
          ...(w.active
            ? color
              // Color-tinted active tab: keep the same bg as inactive
              // tabs of the same color and signal active via cream
              // text + cream border. Avoids the bright olive-green
              // theme accent jumping out against muted swatches.
              ? { color: 'var(--text)', borderColor: 'var(--text)' }
              : { color: 'var(--green)', borderColor: 'var(--green)' }
            : null),
        }}
        onTouchStart={() => { pressStartRef.current = Date.now() }}
        onTouchEnd={handleEnd}
        onTouchCancel={() => { pressStartRef.current = 0 }}
        onMouseDown={() => { pressStartRef.current = Date.now() }}
        onMouseUp={handleEnd}
        onMouseLeave={() => { pressStartRef.current = 0 }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {w.name.match(/^\d+\.\d+/) ? w.index : w.name}
      </button>
      {editing && createPortal(
        <div className="tmux-edit-overlay">
          <div className="tmux-edit-card" ref={containerRef}>
            <input
              ref={inputRef}
              className="tmux-tab-input"
              type="text"
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit() }
                else if (e.key === 'Escape') { e.preventDefault(); cancel() }
              }}
              maxLength={32}
            />
            <div className="tmux-color-swatches">
              {TMUX_COLOR_SWATCHES.map(s => (
                <button
                  key={s.value || 'clear'}
                  type="button"
                  className={`tmux-swatch${pendingColor === s.value ? ' active' : ''}`}
                  style={{ background: s.value || 'transparent' }}
                  aria-label={s.label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.preventDefault(); e.stopPropagation(); hapticTick()
                    setPendingColor(s.value)
                    setLivePreview(s.value)
                    inputRef.current?.focus()
                  }}
                >
                  {s.value ? '' : '×'}
                </button>
              ))}
            </div>
            <div className="tmux-edit-actions">
              <button
                type="button"
                className="tmux-tab-cancel"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); cancel() }}
              >cancel</button>
              <button
                type="button"
                className="tmux-tab-commit"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); commit() }}
              >ok</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

function NowPlayingBarMount({ show, ...props }) {
  const [mounted, setMounted] = useState(show)
  const [exiting, setExiting] = useState(false)
  useEffect(() => {
    if (show) {
      setMounted(true)
      setExiting(false)
    } else if (mounted) {
      setExiting(true)
      const t = setTimeout(() => { setMounted(false); setExiting(false) }, 200)
      return () => clearTimeout(t)
    }
  }, [show, mounted])
  if (!mounted) return null
  return <NowPlayingBar {...props} exiting={exiting} />
}

function App() {
  const { send } = useSync()
  useMediaSession()
  useRouting()
  useNativeNowPlaying({ send })
  usePushTap()
  useVolumeButtons()
  useMariaProximity()

  // One-shot: kill any in-flight Live Activity left over from older app
  // versions that used to start them. We no longer use Live Activities —
  // the lock-screen media widget (MPNowPlayingInfoCenter) covers what we
  // need. Runs once on mount.
  useEffect(() => {
    if (!isNativeIOS) return
    NativePlayer.endLiveActivity?.().catch(() => {})
  }, [])

  const { activeTab, setTab, secretMenuOpen, toggleSecretMenu, refresh, refreshing } = useUIStore(
    useShallow(s => ({
      activeTab: s.activeTab,
      setTab: s.setTab,
      secretMenuOpen: s.secretMenuOpen,
      toggleSecretMenu: s.toggleSecretMenu,
      refresh: s.refresh,
      refreshing: s.refreshing,
    }))
  )
  const { playing, rawClaudeState, claudeOptions, claudeQuestion, tmuxWindows, tmuxColors, tmuxColorPreview } = usePlaybackStore(
    useShallow(s => ({
      playing: s.playing,
      rawClaudeState: s.claudeState,
      claudeOptions: s.claudeOptions,
      claudeQuestion: s.claudeQuestion,
      tmuxWindows: s.tmuxWindows,
      tmuxColors: s.tmuxColors,
      tmuxColorPreview: s.tmuxColorPreview,
    }))
  )
  // Resolve a window's effective color: live preview override first
  // (set by the rename modal so swatch taps animate the whole UI
  // before commit), then the server-broadcast tmuxColors map.
  const resolveColor = (name) => {
    if (tmuxColorPreview && name in tmuxColorPreview) {
      return tmuxColorPreview[name] || null
    }
    return tmuxColors?.[name] || null
  }
  // Active tmux tint for theming the FAB buttons + tab marker — only
  // while the terminal panel is open (the tint is a terminal-context
  // affordance, see NowPlayingBar's same rule).
  const activeTmuxColor = (() => {
    const list = Array.isArray(tmuxWindows) ? tmuxWindows : null
    const active = list?.find(w => w.active)
    return active ? resolveColor(active.name) : null
  })()
  const { connected, phoneOpen, terminalOpen, setTerminalOpen } = useSyncStore(
    useShallow(s => ({
      connected: s.connected,
      phoneOpen: s.phoneOpen,
      terminalOpen: s.terminalOpen,
      setTerminalOpen: s.setTerminalOpen,
    }))
  )
  const [claudeState, setClaudeState] = useState('idle')
  const [claudePressed, setClaudePressed] = useState(null)
  useEffect(() => { if (rawClaudeState === 'waiting') setClaudePressed(null) }, [rawClaudeState])
  useEffect(() => {
    if (rawClaudeState === 'waiting') {
      setClaudeState('waiting')
    } else if (claudeState === 'waiting') {
      const t = setTimeout(() => setClaudeState(rawClaudeState || 'idle'), 500)
      return () => clearTimeout(t)
    } else {
      setClaudeState(rawClaudeState || 'idle')
    }
  }, [rawClaudeState])
  const [terminalEverOpened, setTerminalEverOpened] = useState(false)
  useEffect(() => { if (terminalOpen) setTerminalEverOpened(true) }, [terminalOpen])
  const longPressRef = useRef(null)

  // Toggle body.keyboard-open when iOS soft keyboard is up. CSS uses
  // this to lift FABs above the keyboard only when needed; otherwise
  // they stay at their normal just-above-the-now-playing-bar spot.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const kbH = window.innerHeight - vv.height
      document.body.classList.toggle('keyboard-open', kbH > 100)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      document.body.classList.remove('keyboard-open')
    }
  }, [])

  // Desktop keyboard shortcuts: space play/pause, ←/→ skip 5s
  const kbSkipPosRef = useRef(null)
  const kbSkipResetRef = useRef(null)
  useEffect(() => {
    if (!playing) return
    const onKey = (e) => {
      const target = e.target
      const tag = target?.tagName
      if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.code === 'Space') {
        e.preventDefault()
        fetch('/api/playpause', { method: 'POST' }).catch(() => {})
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault()
        const delta = e.code === 'ArrowLeft' ? -5 : 5
        const pb = usePlaybackStore.getState()
        const base = kbSkipPosRef.current ?? (pb.position || 0)
        const newPos = Math.max(0, Math.min(pb.duration || Infinity, base + delta))
        kbSkipPosRef.current = newPos
        clearTimeout(kbSkipResetRef.current)
        kbSkipResetRef.current = setTimeout(() => { kbSkipPosRef.current = null }, 2000)
        fetch('/api/seek', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: newPos }) }).catch(() => {})
        useUIStore.getState().addToast(`${delta > 0 ? '+' : ''}${delta}s`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playing])
  const didLongPressRef = useRef(false)
  const [macStatus, setMacStatus] = useState({ locked: false, screenOff: false })

  // macStatus comes from WS playback state (no separate polling needed)
  const macStatusFromWs = usePlaybackStore(s => s.macStatus)
  useEffect(() => {
    if (macStatusFromWs) setMacStatus(macStatusFromWs)
  }, [macStatusFromWs])
  const refreshMacStatus = useCallback(() => {
    setTimeout(() => fetch('/api/mac-status').then(r => r.json()).then(setMacStatus).catch(() => {}), 500)
  }, [])

  const tabs = ['rec', 'history', 'subs', 'ru', 'live']
  const tabLabels = { rec: 'Rec', subs: 'Subs', live: 'Live', ru: 'Ru', history: 'Hist' }
  // Per-tab tint applied to body / html / safe-area gutter while on
  // that tab. Same darken pipeline as the tmux window color picker.
  // Picked the first-tmux-panel forest green for History so it
  // visually echoes the editor pane that's most often what's
  // playing.
  const TAB_TINTS = { history: '#1f3d24', live: '#a13a36', ru: '#4f8a5c' }
  const activeTabTint = TAB_TINTS[activeTab] || null

  // Apply per-tab tint to body/html + native safe-area. NO cleanup
  // function — when terminal opens its own effect captures the
  // current bg as prevBody and restores it on close. A cleanup here
  // would race Terminal's effect on transition and leave the page
  // gray. Effect is idempotent: just sets bg to the right value
  // based on (terminalOpen, activeTabTint).
  useEffect(() => {
    if (terminalOpen) return  // Terminal effect owns the theme while open
    const html = document.documentElement
    const body = document.body
    const baseBg = getComputedStyle(body).getPropertyValue('--bg').trim() || '#282828'
    const tintBg = activeTabTint ? darkenHex(activeTabTint) : baseBg
    html.style.background = tintBg
    body.style.background = tintBg
    // The fixed .safe-area-cover reads --gutter-bg; sync it so the
    // Dynamic Island band follows the active tint instead of being
    // permanently var(--bg) gray. Same for --header-bg on .header
    // (the tabs strip).
    html.style.setProperty('--gutter-bg', tintBg)
    html.style.setProperty('--header-bg', tintBg)
    // Active-tab pill highlight: a slightly LIGHTER variant of the
    // tint so it stands out against the header bg. Falls back to
    // --surface gray when no tint is active.
    if (activeTabTint) {
      // Re-use darkenHex but apply an inverse-ish "lighten" by
      // mixing toward white at ~25%.
      const c = activeTabTint.replace('#', '')
      const h = c.length === 3 ? c.split('').map(x => x + x).join('') : c.slice(0, 6)
      const lr = Math.min(255, Math.round(parseInt(h.slice(0, 2), 16) * 0.85 + 255 * 0.15))
      const lg = Math.min(255, Math.round(parseInt(h.slice(2, 4), 16) * 0.85 + 255 * 0.15))
      const lb = Math.min(255, Math.round(parseInt(h.slice(4, 6), 16) * 0.85 + 255 * 0.15))
      const lighter = '#' + [lr, lg, lb].map(v => v.toString(16).padStart(2, '0')).join('')
      html.style.setProperty('--tab-active-bg', lighter)
    } else {
      html.style.removeProperty('--tab-active-bg')
    }
    NativePlayer.setSafeAreaBackground?.(tintBg)?.catch?.(() => {})
  }, [activeTabTint, terminalOpen])

  // Pull-to-refresh: pull down from top to refresh the current tab
  const doRefresh = useCallback(() => {
    if (activeTab === 'channel' || activeTab === 'search' || activeTab === 'filtered') {
      setTab('rec')
    } else {
      refresh()
    }
  }, [activeTab, setTab, refresh])
  const ptrBodyRef = useRef(null)
  const ptrIndicatorRef = useRef(null)
  const ptr = usePullToRefresh({
    onRefresh: doRefresh,
    enabled: !terminalOpen && !phoneOpen,
    bodyEl: useCallback(() => ptrBodyRef.current, []),
    indicatorEl: useCallback(() => ptrIndicatorRef.current, []),
  })

  // Horizontal feed swipe: drag left → next tab, drag right → prev.
  // Same heuristic as the tmux pane swipe in Terminal.jsx (≥80px
  // horizontal travel, dominated >1.5x vs vertical, under 500ms).
  // Skips channel/search/filtered "side" tabs since those don't
  // belong in the carousel ordering.
  const feedSwipeRef = useRef(null)
  const onFeedTouchStart = (e) => {
    if (terminalOpen || phoneOpen) return
    if (e.touches.length !== 1) { feedSwipeRef.current = null; return }
    const t = e.touches[0]
    feedSwipeRef.current = { x: t.clientX, y: t.clientY, at: Date.now(), locked: false }
  }
  const onFeedTouchEnd = (e) => {
    const start = feedSwipeRef.current
    feedSwipeRef.current = null
    if (!start) return
    const t = e.changedTouches[0]
    if (!t) return
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    const dt = Date.now() - start.at
    if (dt > 500) return
    if (Math.abs(dx) < 80) return
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return
    const idx = tabs.indexOf(activeTab)
    if (idx < 0) return  // channel / search / filtered → no carousel
    const next = tabs[(idx + (dx < 0 ? 1 : -1) + tabs.length) % tabs.length]
    if (next && next !== activeTab) {
      hapticTick()
      setTab(next)
    }
  }
  // Native non-passive touchmove on the feed body so once a gesture
  // commits horizontal we can preventDefault and stop the page from
  // scrolling vertically alongside the swipe. React's synthetic
  // onTouchMove is passive — preventDefault there is a no-op.
  useEffect(() => {
    const el = ptrBodyRef.current
    if (!el) return
    const onMove = (e) => {
      const start = feedSwipeRef.current
      if (!start) return
      if (!e.touches || e.touches.length !== 1) return
      const t = e.touches[0]
      const dx = t.clientX - start.x
      const dy = t.clientY - start.y
      // Lock direction once the touch travels enough: if the user
      // committed to horizontal (dx ≥ 16 AND dx > dy*1.2), prevent
      // vertical scroll for the rest of the gesture. If they
      // committed to vertical, leave us alone.
      if (!start.locked) {
        const adx = Math.abs(dx)
        const ady = Math.abs(dy)
        if (adx < 16 && ady < 16) return
        start.locked = adx > ady * 1.2 ? 'h' : 'v'
      }
      if (start.locked === 'h' && e.cancelable) e.preventDefault()
    }
    el.addEventListener('touchmove', onMove, { passive: false })
    return () => el.removeEventListener('touchmove', onMove)
  }, [terminalOpen, phoneOpen])

  return (
    <>
      <div className="safe-area-cover" aria-hidden="true" />
      {phoneOpen && (
        <Suspense fallback={null}>
          <PhonePlayer send={send} />
        </Suspense>
      )}

      <div
        ref={ptrIndicatorRef}
        className="ptr-indicator"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: 0,
          opacity: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          zIndex: 100,
          paddingTop: 'env(safe-area-inset-top, 0)',
          color: ptr.armed ? 'var(--green)' : 'var(--text-dim)',
          fontSize: 'var(--font-sm)',
          fontFamily: 'var(--font)',
          letterSpacing: '2px',
          overflow: 'hidden',
          willChange: 'height, opacity',
        }}
      >
        {ptr.armed ? '◉ RELEASE' : '◯ PULL'}
      </div>
      <div
        ref={ptrBodyRef}
        onTouchStart={onFeedTouchStart}
        onTouchEnd={onFeedTouchEnd}
        onTouchCancel={() => { feedSwipeRef.current = null }}
        style={{
          ...(terminalOpen ? { display: 'none' } : undefined),
        }}
      >
        <header className="header">
          <div className="header-inner">
            <button
              className="logo-btn"
              aria-label="Home"
              onClick={() => {
                hapticTick()
                // Reset to recommended: clear search + channel, flip tab
                useUIStore.setState({
                  activeTab: 'rec',
                  searchQuery: '',
                  channelQuery: null,
                })
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
                <polygon points="5 4 15 12 5 20 5 4" />
              </svg>
            </button>
            <SearchBar />
            <div className="tabs">
              {tabs.map(t => (
                <button
                  key={t}
                  className={`tab${activeTab === t ? ' active' : ''}`}
                  onClick={() => { if (activeTab !== t) hapticTick(); setTab(t) }}
                >
                  {tabLabels[t] || (t.charAt(0).toUpperCase() + t.slice(1))}
                </button>
              ))}
            </div>
            <div className="header-status" onClick={() => { hapticThump(); toggleSecretMenu() }}>
              <div className={`status-dot ${connected ? 'connected' : 'disconnected'}`} title="WebSocket" />
              <div className={`status-dot ${macStatus.ethernet ? 'connected' : 'disconnected'}`} title="Ethernet" />
              <div className={`status-dot ${macStatus.locked ? 'disconnected' : 'connected'}`} title="Unlocked" />
              <div className={`status-dot ${macStatus.screenOff ? 'disconnected' : 'connected'}`} title="Screen" />
              <div className={`status-dot ${macStatus.keepAwake ? 'connected' : 'idle'}`} title="Keep awake" />
            </div>
          </div>
        </header>

        <div className="app">
          <VideoGrid />
        </div>
      </div>

      {terminalOpen && tmuxWindows && tmuxWindows.length > 1 && (
        <div className="tmux-tabs">
          {tmuxWindows.map(w => (
            <TmuxTabButton key={w.index} window={w} color={resolveColor(w.name)} />
          ))}
        </div>
      )}
      {claudeState === 'waiting' && claudeOptions?.length > 0 && (
        <div className="claude-quick-reply">
          {claudeQuestion && <div className="claude-question">{claudeQuestion}</div>}
          {claudeOptions.map((opt) => {
            const n = parseInt(opt.n, 10)
            return (
              <button
                key={opt.n}
                className={claudePressed === n ? 'pressed' : ''}
                onClick={() => {
                  hapticThump()
                  setClaudePressed(n)
                  const fn = useSyncStore.getState().terminalSendKey
                  if (fn) fn(opt.n)
                }}
              >{`${opt.n} ${opt.text}`}</button>
            )
          })}
        </div>
      )}
      <div
        className="fab-stack"
        style={(terminalOpen && activeTmuxColor) ? {
          // Match the FAB chrome to the tmux tint while the terminal
          // is open (raw tint is the brightest version we use, so the
          // FABs read as "lifted" from the darker terminal/np-bar bg).
          '--fab-bg': activeTmuxColor,
          '--fab-bg-active': darkenHex(activeTmuxColor, 0.7),
          '--fab-border': darkenHex(activeTmuxColor, 0.4),
        } : undefined}
      >
        <button
          className="fab-cmux"
          style={claudeState === 'waiting' ? { color: 'var(--magenta)', borderColor: 'var(--magenta)', background: terminalOpen ? 'rgba(177,98,134,0.2)' : undefined } : claudeState === 'thinking' ? { color: 'var(--yellow)', borderColor: 'var(--yellow)', background: terminalOpen ? 'rgba(229,181,103,0.2)' : undefined } : undefined}
          onClick={(e) => { e.stopPropagation(); hapticTick(); setTerminalOpen(!useSyncStore.getState().terminalOpen) }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
            <rect x="2" y="3" width="20" height="18" rx="2" /><polyline points="6 9 10 13 6 17" /><line x1="14" y1="17" x2="18" y2="17" />
          </svg>
        </button>
        <button
          className="fab-refresh"
          onClick={() => {
            if (didLongPressRef.current) { didLongPressRef.current = false; return }
            hapticTick()
            // Smooth scroll only if we're not already at top
            if (window.scrollY > 4) {
              window.scrollTo({ top: 0, behavior: 'smooth' })
            }
            if (activeTab === 'channel' || activeTab === 'search' || activeTab === 'filtered') {
              setTab('rec')
            } else {
              refresh()
            }
          }}
          onTouchStart={() => {
            didLongPressRef.current = false
            longPressRef.current = setTimeout(() => {
              didLongPressRef.current = true
              hapticThump()
              toggleSecretMenu()
            }, 500)
          }}
          onTouchEnd={() => clearTimeout(longPressRef.current)}
          onTouchCancel={() => clearTimeout(longPressRef.current)}
          onContextMenu={(e) => e.preventDefault()}
        >
          {activeTab === 'channel' || activeTab === 'search' || activeTab === 'filtered' ? (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
              <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" className={refreshing ? 'spin' : undefined}>
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
          )}
        </button>
      </div>

      {terminalEverOpened && (
        <Suspense fallback={null}>
          <div style={{ display: terminalOpen ? '' : 'none' }}>
            <Terminal onClose={() => setTerminalOpen(false)} hasNowPlaying={playing} tmuxWindows={tmuxWindows} tmuxColors={tmuxColors} tmuxColorPreview={tmuxColorPreview} visible={terminalOpen} />
          </div>
        </Suspense>
      )}
      <NowPlayingBarMount show={playing} send={send} frontApp={macStatus.frontApp} refreshStatus={refreshMacStatus} />
      {useSyncStore(s => s.commentsOpen) && playing && <CommentsPanel />}
      {secretMenuOpen && <SecretMenu />}

      <Toast />
      <VolumeHud />
      <ClaudeFeed />
    </>
  )
}

export default App
