import { useEffect, useRef, useState, useCallback } from 'react'
import { useSync } from './hooks/useSync'
import { useMediaSession } from './hooks/useMediaSession'
import { useUIStore } from './stores/ui'
import { usePlaybackStore } from './stores/playback'
import { useSyncStore } from './stores/sync'
import VideoGrid from './components/VideoGrid'
import NowPlayingBar from './components/NowPlayingBar'
import PhonePlayer from './components/PhonePlayer'
import SecretMenu from './components/SecretMenu'
import SearchBar from './components/SearchBar'
import Toast from './components/Toast'
import { lazy, Suspense } from 'react'
const Terminal = lazy(() => import('./components/Terminal'))
import './App.css'

function App() {
  const { send } = useSync()
  useMediaSession()
  const activeTab = useUIStore(s => s.activeTab)
  const setTab = useUIStore(s => s.setTab)
  const secretMenuOpen = useUIStore(s => s.secretMenuOpen)
  const toggleSecretMenu = useUIStore(s => s.toggleSecretMenu)
  const playing = usePlaybackStore(s => s.playing)
  const rawClaudeState = usePlaybackStore(s => s.claudeState)
  const [claudeState, setClaudeState] = useState('idle')
  useEffect(() => {
    if (rawClaudeState === 'waiting') {
      setClaudeState('waiting')
    } else if (claudeState === 'waiting') {
      // Keep waiting visible for 3s so user can tap buttons
      const t = setTimeout(() => setClaudeState(rawClaudeState || 'idle'), 3000)
      return () => clearTimeout(t)
    } else {
      setClaudeState(rawClaudeState || 'idle')
    }
  }, [rawClaudeState])
  const claudeOptions = usePlaybackStore(s => s.claudeOptions)
  const claudeQuestion = usePlaybackStore(s => s.claudeQuestion)
  const tmuxWindows = usePlaybackStore(s => s.tmuxWindows)
  const connected = useSyncStore(s => s.connected)
  const phoneOpen = useSyncStore(s => s.phoneOpen)
  const terminalOpen = useSyncStore(s => s.terminalOpen)
  const setTerminalOpen = useSyncStore(s => s.setTerminalOpen)
  const [terminalEverOpened, setTerminalEverOpened] = useState(false)
  useEffect(() => { if (terminalOpen) setTerminalEverOpened(true) }, [terminalOpen])
  const refresh = useUIStore(s => s.refresh)
  const longPressRef = useRef(null)
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

  const tabs = ['rec', 'subs', 'live', 'history']

  return (
    <>
      {phoneOpen && <PhonePlayer send={send} />}

      <div className="app" style={terminalOpen ? { display: 'none' } : undefined}>
        <header className="header">
          <SearchBar />
          <div className="tabs">
            {tabs.map(t => (
              <button
                key={t}
                className={`tab${activeTab === t ? ' active' : ''}`}
                onClick={() => setTab(t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <div className="header-status" onClick={toggleSecretMenu}>
            <div className={`status-dot ${connected ? 'connected' : 'disconnected'}`} title="WebSocket" />
            <div className={`status-dot ${macStatus.ethernet ? 'connected' : 'disconnected'}`} title="Ethernet" />
            <div className={`status-dot ${macStatus.locked ? 'disconnected' : 'connected'}`} title="Unlocked" />
            <div className={`status-dot ${macStatus.screenOff ? 'disconnected' : 'connected'}`} title="Screen" />
          </div>
        </header>

        <VideoGrid />
      </div>

      {terminalOpen && tmuxWindows && tmuxWindows.length > 1 && (
        <div className="tmux-tabs">
          {tmuxWindows.map(w => (
            <button
              key={w.index}
              style={w.active ? { color: 'var(--green)', borderColor: 'var(--green)' } : undefined}
              onClick={(e) => { e.stopPropagation(); fetch('/api/tmux-select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: w.index }) }).catch(() => {}) }}
            >
              {w.name.match(/^\d+\.\d+/) ? w.index : w.name.slice(0, 3)}
            </button>
          ))}
        </div>
      )}
      {claudeState === 'waiting' && (
        <div className="claude-quick-reply">
          {claudeQuestion && <div className="claude-question">{claudeQuestion}</div>}
          {[1,2,3].map(n => {
            const opt = claudeOptions?.find(o => o.n === String(n))
            const label = opt ? `${n} ${opt.text}` : String(n)
            return <button key={n} onClick={() => { const fn = useSyncStore.getState().terminalSendKey; if (fn) fn(String(n)); }}>{label}</button>
          })}
        </div>
      )}
      <div className="fab-stack">
        <button
          className="fab-cmux"
          style={claudeState === 'waiting' ? { color: 'var(--magenta)', borderColor: 'var(--magenta)' } : claudeState === 'thinking' ? { color: 'var(--yellow)', borderColor: 'var(--yellow)' } : undefined}
          onClick={(e) => { e.stopPropagation(); setTerminalOpen(!useSyncStore.getState().terminalOpen) }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
            <rect x="2" y="3" width="20" height="18" rx="2" /><polyline points="6 9 10 13 6 17" /><line x1="14" y1="17" x2="18" y2="17" />
          </svg>
        </button>
        <button
          className="fab-refresh"
          onClick={() => {
            if (didLongPressRef.current) { didLongPressRef.current = false; return }
            if (activeTab === 'channel' || activeTab === 'search') {
              setTab('rec')
            } else {
              refresh()
            }
          }}
          onTouchStart={() => {
            didLongPressRef.current = false
            longPressRef.current = setTimeout(() => {
              didLongPressRef.current = true
              toggleSecretMenu()
            }, 500)
          }}
          onTouchEnd={() => clearTimeout(longPressRef.current)}
          onTouchCancel={() => clearTimeout(longPressRef.current)}
          onContextMenu={(e) => e.preventDefault()}
        >
          {activeTab === 'channel' || activeTab === 'search' ? (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
              <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
          )}
        </button>
      </div>

      {terminalEverOpened && (
        <Suspense fallback={null}>
          <div style={{ display: terminalOpen ? '' : 'none' }}>
            <Terminal onClose={() => setTerminalOpen(false)} hasNowPlaying={playing} tmuxWindows={tmuxWindows} />
          </div>
        </Suspense>
      )}
      {playing && <NowPlayingBar send={send} frontApp={macStatus.frontApp} refreshStatus={refreshMacStatus} />}
      {secretMenuOpen && <SecretMenu />}

      <Toast />
    </>
  )
}

export default App
