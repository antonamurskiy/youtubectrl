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
import './App.css'

function App() {
  const { send } = useSync()
  useMediaSession()
  const activeTab = useUIStore(s => s.activeTab)
  const setTab = useUIStore(s => s.setTab)
  const secretMenuOpen = useUIStore(s => s.secretMenuOpen)
  const toggleSecretMenu = useUIStore(s => s.toggleSecretMenu)
  const playing = usePlaybackStore(s => s.playing)
  const connected = useSyncStore(s => s.connected)
  const phoneOpen = useSyncStore(s => s.phoneOpen)
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

  const tabs = ['home', 'live', 'history']

  return (
    <>
      {phoneOpen && <PhonePlayer send={send} />}

      <div className="app">
        <header className="header">
          <span className="logo-text" onClick={toggleSecretMenu}>
            ytctrl
          </span>
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
            <div className={`status-dot ${macStatus.locked ? 'disconnected' : 'connected'}`} title="Unlocked" />
            <div className={`status-dot ${macStatus.screenOff ? 'disconnected' : 'connected'}`} title="Screen" />
          </div>
        </header>

        <VideoGrid />
      </div>

      <button
        className="fab-refresh"
        onClick={() => {
          if (didLongPressRef.current) { didLongPressRef.current = false; return }
          refresh()
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
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
        </svg>
      </button>

      {playing && <NowPlayingBar send={send} frontApp={macStatus.frontApp} refreshStatus={refreshMacStatus} />}
      {secretMenuOpen && <SecretMenu />}

      <Toast />
    </>
  )
}

export default App
