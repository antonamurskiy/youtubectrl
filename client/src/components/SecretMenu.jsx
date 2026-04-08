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
    // Get initial mute state
    try {
      fetch('/api/volume-status').then(r => r.json()).then(d => { setMuted(!!d.muted); if (d.volume != null && !draggingRef.current) setVolume(d.volume) }).catch(() => {})
    } catch {}
    fetch('/api/audio-outputs').then(r => r.json()).then(d => {
      setAudioOutputs(d.outputs || [])
      setCurrentOutput(d.current || '')
    }).catch(() => {})
  }, [])

  const updateVolume = useCallback((clientY) => {
    const el = volAreaRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const y = clientY - rect.top
    if (y < -20 || y > rect.height + 20) return // ignore events far outside
    const clamped = Math.max(0, Math.min(y, rect.height))
    const vol = Math.round(100 - (clamped / rect.height) * 100)
    setVolume(vol)
    fetch('/api/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: vol }),
    }).catch(() => {})
  }, [])

  const handlePointerDown = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    draggingRef.current = true
    updateVolume(e.clientY)
    const handleMove = (ev) => {
      ev.preventDefault()
      if (draggingRef.current) updateVolume(ev.clientY)
    }
    const handleUp = (ev) => {
      ev.preventDefault()
      draggingRef.current = false
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
    }
    document.addEventListener('pointermove', handleMove, { passive: false })
    document.addEventListener('pointerup', handleUp)
  }, [updateVolume])

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
      <div style={{ position: 'fixed', inset: 0, zIndex: 599 }} onClick={toggleSecretMenu} />
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

        <button className="secret-menu-item" onClick={() => {
          fetch('/api/focus-cmux', { method: 'POST' }).then(() => addToast('cmux focused')).catch(() => addToast('Focus failed'))
          toggleSecretMenu()
        }}>
          Focus cmux
        </button>

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
