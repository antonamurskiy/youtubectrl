import { useState, useRef, useCallback, useEffect } from 'react'
import { useUIStore } from '../stores/ui'
import { useSyncStore } from '../stores/sync'
import { usePlaybackStore } from '../stores/playback'

export default function SecretMenu() {
  const toggleSecretMenu = useUIStore(s => s.toggleSecretMenu)
  const addToast = useUIStore(s => s.addToast)
  const connected = useSyncStore(s => s.connected)
  const macStatus = usePlaybackStore(s => s.macStatus) || {}
  const cachedVolume = useUIStore(s => s.cachedVolume)
  const setCachedVolume = useUIStore(s => s.setCachedVolume)
  const [volume, setVolumeLocal] = useState(cachedVolume ?? 50)
  const setVolume = (v) => { setVolumeLocal(v); setCachedVolume(v) }
  const [audioOutputs, setAudioOutputs] = useState([])
  const [currentOutput, setCurrentOutput] = useState('')
  const [showOutputs, setShowOutputs] = useState(false)
  const [muted, setMuted] = useState(false)
  const volAreaRef = useRef(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    let stale = false
    fetch('/api/volume-status').then(r => r.json()).then(d => {
      if (stale || draggingRef.current) return
      setMuted(!!d.muted)
      if (d.volume != null) setVolume(d.volume)
    }).catch(() => {})
    fetch('/api/audio-outputs').then(r => r.json()).then(d => {
      if (stale) return
      setAudioOutputs(d.outputs || [])
      setCurrentOutput(d.current || '')
    }).catch(() => {})
    return () => { stale = true }
  }, [])

  const lastSentVol = useRef(null)
  const updateVolume = useCallback((clientY) => {
    const el = volAreaRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const y = clientY - rect.top
    const clamped = Math.max(0, Math.min(y, rect.height))
    const vol = Math.round(100 - (clamped / rect.height) * 100)
    setVolume(vol)
    if (lastSentVol.current !== vol) {
      lastSentVol.current = vol
      fetch('/api/volume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: vol }),
      }).catch(() => {})
    }
  }, [])

  const handlePointerDown = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const el = volAreaRef.current
    if (el) el.setPointerCapture(e.pointerId)
    draggingRef.current = true
    updateVolume(e.clientY)
  }, [updateVolume])

  const handlePointerMove = useCallback((e) => {
    if (draggingRef.current) {
      e.preventDefault()
      updateVolume(e.clientY)
    }
  }, [updateVolume])

  const handlePointerUp = useCallback((e) => {
    draggingRef.current = false
    const el = volAreaRef.current
    if (el) el.releasePointerCapture(e.pointerId)
  }, [])

  const switchOutput = useCallback((name) => {
    fetch('/api/audio-output', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(() => { setCurrentOutput(name); addToast(`→ ${name}`) })
      .catch(() => addToast('Switch failed'))
    setShowOutputs(false)
  }, [addToast])

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 599 }} onClick={() => { if (!draggingRef.current) toggleSecretMenu() }} />
      <div className="secret-menu">
        <div className="secret-menu-item" style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'center', padding: '10px 12px' }}>
          {[
            { on: connected, label: 'WS' },
            { on: macStatus.ethernet, label: 'ETH' },
            { on: !macStatus.locked, label: 'UNLK' },
            { on: !macStatus.screenOff, label: 'SCR' },
          ].map(({ on, label }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div className={`status-dot ${on ? 'connected' : 'disconnected'}`} />
              <span style={{ fontSize: 'var(--font-lg)', color: 'var(--text-dim)' }}>{label}</span>
            </div>
          ))}
        </div>
        <div
          className="secret-menu-item vol-area"
          ref={volAreaRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div className="vol-fill" style={{ height: `${volume}%` }} />
          <div className="vol-label">{volume}%</div>
        </div>

        <button
          className="secret-menu-item"
          style={{
            color: muted ? 'var(--red)' : 'var(--text)',
            background: muted ? 'rgba(255,50,50,0.1)' : 'none',
          }}
          onClick={() => {
            fetch('/api/mute', { method: 'POST' }).then(r => r.json()).then(d => { setMuted(d.muted); addToast(d.muted ? 'Muted' : 'Unmuted') }).catch(() => addToast('Mute failed'))
          }}
        >
          {muted ? 'Muted ●' : 'Mute'}
        </button>

        <button className="secret-menu-item" onClick={() => setShowOutputs(!showOutputs)}>
          Audio: {currentOutput || '...'}
        </button>
        {showOutputs && audioOutputs.map(name => (
          <button
            key={name}
            className="secret-menu-item"
            style={{ paddingLeft: 24, color: name === currentOutput ? 'var(--accent)' : 'var(--text)' }}
            onClick={() => switchOutput(name)}
          >
            {name === currentOutput ? '● ' : '  '}{name}
          </button>
        ))}

        {useUIStore.getState().filteredVideos.length > 0 && (
          <button className="secret-menu-item" onClick={() => {
            useUIStore.getState().setTab('filtered')
            toggleSecretMenu()
          }}>
            Filtered ({useUIStore.getState().filteredVideos.length})
          </button>
        )}

        <button className="secret-menu-item" onClick={() => {
          fetch('/api/toggle-resolution', { method: 'POST' }).then(() => addToast('Resolution toggled')).catch(() => addToast('Toggle failed'))
          toggleSecretMenu()
        }}>
          Toggle resolution
        </button>
        <button className="secret-menu-item" onClick={() => {
          fetch('/api/refresh-cookies', { method: 'POST' }).then(() => addToast('Cookies refreshed')).catch(() => addToast('Refresh failed'))
          toggleSecretMenu()
        }}>
          Refresh cookies
        </button>
        <button className="secret-menu-item" onClick={() => {
          fetch('/api/lock-mac', { method: 'POST' }).then(() => addToast('Mac locked')).catch(() => addToast('Lock failed'))
          toggleSecretMenu()
        }}>
          Lock Mac
        </button>
        <button className="secret-menu-item" onClick={toggleSecretMenu} style={{ color: 'var(--accent2)' }}>
          Close
        </button>
      </div>
    </>
  )
}
