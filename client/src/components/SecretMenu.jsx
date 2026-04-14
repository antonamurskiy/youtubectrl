import { useState, useRef, useCallback, useEffect } from 'react'
import { useUIStore } from '../stores/ui'
import { useSyncStore } from '../stores/sync'
import { usePlaybackStore } from '../stores/playback'
import { FONTS, applyFont, currentFont } from '../fonts'

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
  const [btDevices, setBtDevices] = useState([])
  const [showBt, setShowBt] = useState(false)
  const [showFonts, setShowFonts] = useState(false)
  const [fontSel, setFontSel] = useState(currentFont())
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
  const inFlightRef = useRef(false)
  const pendingVolRef = useRef(null)
  const sendVolume = useCallback(() => {
    if (inFlightRef.current || pendingVolRef.current == null) return
    const vol = pendingVolRef.current
    pendingVolRef.current = null
    if (lastSentVol.current === vol) return
    lastSentVol.current = vol
    inFlightRef.current = true
    fetch('/api/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: vol }),
    }).catch(() => {}).finally(() => {
      inFlightRef.current = false
      if (pendingVolRef.current != null) sendVolume()
    })
  }, [])

  const updateVolume = useCallback((clientY) => {
    const el = volAreaRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) return
    const y = clientY - rect.top
    const clamped = Math.max(0, Math.min(y, rect.height))
    const vol = Math.round(100 - (clamped / rect.height) * 100)
    setVolume(vol)
    pendingVolRef.current = vol
    sendVolume()
  }, [sendVolume])

  useEffect(() => {
    const el = volAreaRef.current
    if (!el) return
    const onTouchStart = (e) => {
      if (!e.touches || e.touches.length === 0) return
      e.preventDefault()
      draggingRef.current = true
      updateVolume(e.touches[0].clientY)
    }
    const onTouchMove = (e) => {
      if (!draggingRef.current || !e.touches || e.touches.length === 0) return
      e.preventDefault()
      updateVolume(e.touches[0].clientY)
    }
    const onTouchEnd = () => {
      // keep dragging flag briefly so the overlay click doesn't close the menu
      setTimeout(() => { draggingRef.current = false }, 50)
    }
    const onMouseDown = (e) => {
      draggingRef.current = true
      updateVolume(e.clientY)
      const move = (ev) => { if (draggingRef.current) updateVolume(ev.clientY) }
      const up = () => {
        setTimeout(() => { draggingRef.current = false }, 50)
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    }
    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    el.addEventListener('mousedown', onMouseDown)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('mousedown', onMouseDown)
    }
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
      <div style={{ position: 'fixed', inset: 0, zIndex: 599 }} onClick={() => { if (!draggingRef.current) toggleSecretMenu() }} />
      <div className="secret-menu">
        <div className="secret-menu-item" style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', padding: '10px 8px' }}>
          {[
            { on: connected, label: 'WS' },
            { on: macStatus.ethernet, label: 'ETH' },
            { on: !macStatus.locked, label: 'UNLK' },
            { on: !macStatus.screenOff, label: 'SCR' },
            // Keep-awake: gray when off instead of red (not an error state)
            { on: macStatus.keepAwake, label: 'AWK', offState: 'idle' },
          ].map(({ on, label, offState }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <div className={`status-dot ${on ? 'connected' : (offState || 'disconnected')}`} />
              <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{label}</span>
            </div>
          ))}
        </div>
        <div
          className="secret-menu-item vol-area"
          ref={volAreaRef}
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
          if (!showBt) {
            fetch('/api/bluetooth-devices').then(r => r.json()).then(d => setBtDevices(d.devices || [])).catch(() => {})
          }
          setShowBt(!showBt)
        }}>
          Bluetooth
        </button>
        {showBt && btDevices.map(d => (
          <button
            key={d.address}
            className="secret-menu-item"
            style={{ paddingLeft: 24, color: d.connected ? 'var(--accent)' : 'var(--text)' }}
            onClick={() => {
              const action = d.connected ? 'disconnect' : 'connect'
              fetch(`/api/bluetooth-${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: d.address }) })
                .then(r => r.json()).then(res => {
                  addToast(res.ok ? `${action === 'connect' ? 'Connected' : 'Disconnected'} ${d.name}` : 'Failed')
                  fetch('/api/bluetooth-devices').then(r => r.json()).then(dd => setBtDevices(dd.devices || [])).catch(() => {})
                }).catch(() => addToast('Failed'))
            }}
          >
            {d.connected ? '● ' : '  '}{d.name}
          </button>
        ))}

        <button className="secret-menu-item" onClick={() => setShowFonts(!showFonts)}>
          Font: {fontSel}
        </button>
        {showFonts && FONTS.map(([label, family]) => (
          <button
            key={label}
            className="secret-menu-item"
            style={{ paddingLeft: 24, fontFamily: family, color: label === fontSel ? 'var(--green)' : 'var(--text)' }}
            onClick={() => { applyFont(label); setFontSel(label) }}
          >
            {label === fontSel ? '● ' : '  '}{label}
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
          const wake = macStatus.screenOff
          const endpoint = wake ? '/api/wake-mac' : '/api/lock-mac'
          const okMsg = wake ? 'Waking' : 'Mac locked'
          const failMsg = wake ? 'Wake failed' : 'Lock failed'
          fetch(endpoint, { method: 'POST' }).then(() => addToast(okMsg)).catch(() => addToast(failMsg))
          toggleSecretMenu()
        }}>
          {macStatus.screenOff ? 'Wake Mac' : 'Lock Mac'}
        </button>
        <button className="secret-menu-item" style={{ color: macStatus.keepAwake ? 'var(--green)' : undefined }} onClick={() => {
          const next = !macStatus.keepAwake
          fetch('/api/keep-awake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enable: next }) })
            .then(() => addToast(next ? 'Keep awake on' : 'Keep awake off'))
            .catch(() => addToast('Keep awake failed'))
        }}>
          Keep awake {macStatus.keepAwake ? '✓' : ''}
        </button>
        <button className="secret-menu-item" onClick={toggleSecretMenu} style={{ color: 'var(--accent2)' }}>
          Close
        </button>
      </div>
    </>
  )
}
