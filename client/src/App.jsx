import { useEffect } from 'react'
import { useSync } from './hooks/useSync'
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
  const activeTab = useUIStore(s => s.activeTab)
  const setTab = useUIStore(s => s.setTab)
  const secretMenuOpen = useUIStore(s => s.secretMenuOpen)
  const toggleSecretMenu = useUIStore(s => s.toggleSecretMenu)
  const playing = usePlaybackStore(s => s.playing)
  const connected = useSyncStore(s => s.connected)
  const phoneOpen = useSyncStore(s => s.phoneOpen)

  const tabs = ['home', 'live', 'history']

  return (
    <>
      {phoneOpen && <PhonePlayer send={send} />}

      <div className="app">
        <header className="header">
          <span className="logo-text" onClick={toggleSecretMenu}>
            ytctrl
          </span>
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
          <SearchBar />
          <div className="header-status">
            {connected && <div className="status-dot" />}
          </div>
        </header>

        <VideoGrid />
      </div>

      {playing && <NowPlayingBar send={send} />}
      {secretMenuOpen && <SecretMenu />}

      <Toast />
    </>
  )
}

export default App
