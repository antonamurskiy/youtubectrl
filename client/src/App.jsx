import { useEffect, useRef, useState, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { flushSync } from 'react-dom'
import { tick as hapticTick, thump as hapticThump } from './haptics'
import { useSync } from './hooks/useSync'
import { useMediaSession } from './hooks/useMediaSession'
import { useNativeNowPlaying } from './hooks/useNativeNowPlaying'
import { useClaudeNotification } from './hooks/useClaudeNotification'
import { useUIStore } from './stores/ui'
import { usePlaybackStore } from './stores/playback'
import { useSyncStore } from './stores/sync'
import VideoGrid from './components/VideoGrid'
import NowPlayingBar from './components/NowPlayingBar'
import SecretMenu from './components/SecretMenu'
import CommentsPanel from './components/CommentsPanel'
import SearchBar from './components/SearchBar'
import { useRouting } from './hooks/useRouting'
import Toast from './components/Toast'
import { lazy, Suspense } from 'react'
const Terminal = lazy(() => import('./components/Terminal'))
const PhonePlayer = lazy(() => import('./components/PhonePlayer'))
import './App.css'

function TmuxTabButton({ window: w }) {
  const pressStartRef = useRef(0)
  const inputRef = useRef(null)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(w.name)

  const commit = () => {
    const next = value.trim()
    if (next && next !== w.name) {
      fetch('/api/tmux-rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: w.index, name: next }) }).catch(() => {})
    }
    setEditing(false)
  }
  const cancel = () => { setValue(w.name); setEditing(false) }

  const enterEdit = () => {
    hapticTick()
    setValue(w.name)
    flushSync(() => setEditing(true))
    if (inputRef.current) {
      inputRef.current.focus()
      const len = inputRef.current.value.length
      inputRef.current.setSelectionRange(len, len)
    }
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

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="tmux-tab-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          else if (e.key === 'Escape') { e.preventDefault(); cancel() }
        }}
        maxLength={32}
      />
    )
  }

  return (
    <button
      style={w.active ? { color: 'var(--green)', borderColor: 'var(--green)' } : undefined}
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
  )
}

function App() {
  const { send } = useSync()
  useMediaSession()
  useRouting()
  useNativeNowPlaying({ send })
  useClaudeNotification()
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
  const { playing, rawClaudeState, claudeOptions, claudeQuestion, tmuxWindows } = usePlaybackStore(
    useShallow(s => ({
      playing: s.playing,
      rawClaudeState: s.claudeState,
      claudeOptions: s.claudeOptions,
      claudeQuestion: s.claudeQuestion,
      tmuxWindows: s.tmuxWindows,
    }))
  )
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

  const tabs = ['rec', 'subs', 'live', 'ru', 'history']

  return (
    <>
      {phoneOpen && (
        <Suspense fallback={null}>
          <PhonePlayer send={send} />
        </Suspense>
      )}

      <div style={terminalOpen ? { display: 'none' } : undefined}>
        <header className="header">
          <div className="header-inner">
            <SearchBar />
            <div className="tabs">
              {tabs.map(t => (
                <button
                  key={t}
                  className={`tab${activeTab === t ? ' active' : ''}`}
                  onClick={() => { if (activeTab !== t) hapticTick(); setTab(t) }}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
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
            <TmuxTabButton key={w.index} window={w} />
          ))}
        </div>
      )}
      {claudeState === 'waiting' && (
        <div className="claude-quick-reply">
          {claudeQuestion && <div className="claude-question">{claudeQuestion}</div>}
          {[1,2,3].map(n => {
            const opt = claudeOptions?.find(o => o.n === String(n))
            const label = opt ? `${n} ${opt.text}` : String(n)
            return (
              <button
                key={n}
                className={claudePressed === n ? 'pressed' : ''}
                onClick={() => {
                  hapticThump()
                  setClaudePressed(n)
                  const fn = useSyncStore.getState().terminalSendKey
                  if (fn) fn(String(n))
                }}
              >{label}</button>
            )
          })}
        </div>
      )}
      <div className="fab-stack">
        <button
          className="fab-cmux"
          style={claudeState === 'waiting' ? { color: 'var(--magenta)', borderColor: 'var(--magenta)', background: terminalOpen ? 'rgba(177,98,134,0.2)' : undefined } : claudeState === 'thinking' ? { color: 'var(--yellow)', borderColor: 'var(--yellow)', background: terminalOpen ? 'rgba(229,181,103,0.2)' : undefined } : terminalOpen ? { background: 'rgba(168,153,132,0.2)' } : undefined}
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
            <Terminal onClose={() => setTerminalOpen(false)} hasNowPlaying={playing} tmuxWindows={tmuxWindows} visible={terminalOpen} />
          </div>
        </Suspense>
      )}
      {playing && <NowPlayingBar send={send} frontApp={macStatus.frontApp} refreshStatus={refreshMacStatus} />}
      {useSyncStore(s => s.commentsOpen) && playing && <CommentsPanel />}
      {secretMenuOpen && <SecretMenu />}

      <Toast />
    </>
  )
}

export default App
