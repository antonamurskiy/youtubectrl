import { useState, useRef, useCallback, useEffect } from 'react'
import { useUIStore } from '../stores/ui'
import { useSyncStore } from '../stores/sync'
import { usePlaybackStore } from '../stores/playback'
import { FONTS, applyFont, currentFont, FONT_SIZES, applyFontSize, currentFontSize } from '../fonts'
import { isNativeIOS, NativePlayer } from '../native/player'
import { tick as hapticTick, thump as hapticThump, selection as hapticSelection, selectionStart as hapticSelectionStart, selectionEnd as hapticSelectionEnd } from '../haptics'

const MIN_SIZE = 9
const MAX_SIZE = 20

// Toggle the video grid between "compact" (small thumb + info row) and
// "wide" (full-width thumbnail like the official YouTube app). Persists
// via the uiStore → localStorage. Closes the menu on tap so the change
// is immediately visible.
function GridStyleToggle({ onAfter }) {
  const gridStyle = useUIStore(s => s.gridStyle)
  const setGridStyle = useUIStore(s => s.setGridStyle)
  const next = gridStyle === 'wide' ? 'compact' : 'wide'
  return (
    <button
      className="secret-menu-item"
      onClick={() => {
        hapticTick()
        setGridStyle(next)
        onAfter?.()
      }}
    >
      Grid: {gridStyle === 'wide' ? 'wide' : 'compact'} → {next}
    </button>
  )
}

// Find My (macOS app) show/hide with live state reflection.
// Polls /api/findmy-status on mount so the label and color reflect
// whatever the Mac is actually doing (not whatever we last poked).
function FindMyToggle({ onAfter, addToast }) {
  const [visible, setVisible] = useState(null)
  useEffect(() => {
    fetch('/api/findmy-status').then(r => r.json()).then(d => setVisible(!!d.visible)).catch(() => setVisible(false))
  }, [])
  const label = visible == null ? 'Find My…' : (visible ? 'Hide Find My' : 'Show Find My')
  const color = visible ? 'var(--green)' : 'var(--text-dim)'
  return (
    <button
      className="secret-menu-item"
      style={{ color, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
      onClick={() => {
        hapticTick()
        fetch('/api/toggle-findmy', { method: 'POST' })
          .then(r => r.json())
          .then(d => { setVisible(!!d.visible); addToast(d.visible ? 'Find My shown' : 'Find My hidden') })
          .catch(() => addToast('Find My toggle failed'))
        onAfter?.()
      }}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
        {/* Map pin with centered dot — Find My's iconography */}
        <path d="M12 22s-7-7.58-7-12a7 7 0 0 1 14 0c0 4.42-7 12-7 12z" />
        <circle cx="12" cy="10" r="2.5" />
      </svg>
      {label}
    </button>
  )
}

// Phone sync offset slider. Uses native <input type=range> for
// bulletproof touch handling. Persisted server-side to
// `.sync-offset.json`.
function SyncOffsetSlider() {
  const [ms, setMs] = useState(null)
  useEffect(() => {
    fetch('/api/sync-offset').then(r => r.json()).then(d => setMs(d.ms ?? 0)).catch(() => setMs(0))
  }, [])
  const onChange = (e) => {
    const v = parseInt(e.target.value, 10)
    setMs(v)
    hapticSelection()
    fetch('/api/sync-offset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms: v }),
    }).catch(() => {})
  }
  if (ms == null) return null
  return (
    <div className="sync-offset-row">
      <div className="sync-offset-label">
        <span>Sync</span>
        <span style={{ color: ms === 0 ? 'var(--text-dim)' : 'var(--text)' }}>
          {ms > 0 ? '+' : ''}{ms}ms
        </span>
      </div>
      <input
        className="sync-offset-slider"
        type="range"
        min="-8000"
        max="8000"
        step="100"
        value={ms}
        onChange={onChange}
      />
    </div>
  )
}

function FontSizeScrubber({ value, onChange }) {
  const ref = useRef(null)
  const draggingRef = useRef(false)

  const update = useCallback((clientX) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width))
    const pct = x / rect.width
    const n = Math.round(MIN_SIZE + pct * (MAX_SIZE - MIN_SIZE))
    if (n !== value) { onChange(n); hapticSelection() }
  }, [value, onChange])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onTouchStart = (e) => {
      if (!e.touches || e.touches.length === 0) return
      e.preventDefault()
      draggingRef.current = true
      hapticSelectionStart()
      update(e.touches[0].clientX)
    }
    const onTouchMove = (e) => {
      if (!draggingRef.current || !e.touches || e.touches.length === 0) return
      e.preventDefault()
      update(e.touches[0].clientX)
    }
    const onTouchEnd = () => {
      setTimeout(() => { draggingRef.current = false }, 50)
      hapticSelectionEnd()
    }
    const onMouseDown = (e) => {
      draggingRef.current = true
      update(e.clientX)
      const move = (ev) => { if (draggingRef.current) update(ev.clientX) }
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
  }, [update])

  const pct = ((value - MIN_SIZE) / (MAX_SIZE - MIN_SIZE)) * 100
  return (
    <div className="secret-menu-item size-area" ref={ref}>
      <div className="size-fill" style={{ width: `${pct}%` }} />
      <div className="size-label">{value}px</div>
    </div>
  )
}

export default function SecretMenu() {
  const toggleSecretMenu = useUIStore(s => s.toggleSecretMenu)
  const addToast = useUIStore(s => s.addToast)
  const connected = useSyncStore(s => s.connected)
  const phoneOpen = useSyncStore(s => s.phoneOpen)
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
  const [showMisc, setShowMisc] = useState(false)
  const [fontSel, setFontSel] = useState(currentFont())
  const [fontSize, setFontSize] = useState(currentFontSize())
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
    }).then(() => {
      // Broadcast so the Live Activity widget stays in sync
      window.dispatchEvent(new CustomEvent('mac-volume', { detail: { volume: vol } }))
    }).catch(() => {}).finally(() => {
      inFlightRef.current = false
      if (pendingVolRef.current != null) sendVolume()
    })
  }, [])

  const lastVolHapticRef = useRef(-1)
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
    // Haptic tick every 5% step
    const step = Math.floor(vol / 5)
    if (step !== lastVolHapticRef.current) {
      lastVolHapticRef.current = step
      hapticSelection()
    }
  }, [sendVolume])

  useEffect(() => {
    const el = volAreaRef.current
    if (!el) return
    const onTouchStart = (e) => {
      if (!e.touches || e.touches.length === 0) return
      e.preventDefault()
      draggingRef.current = true
      hapticSelectionStart()
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
      hapticSelectionEnd()
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
            hapticThump()
            fetch('/api/mute', { method: 'POST' }).then(r => r.json()).then(d => { setMuted(d.muted); addToast(d.muted ? 'Muted' : 'Unmuted') }).catch(() => addToast('Mute failed'))
          }}
        >
          {muted ? 'Muted ●' : 'Mute'}
        </button>

        <button className="secret-menu-item" onClick={() => { hapticTick(); setShowOutputs(!showOutputs) }}>
          Audio: {currentOutput || '...'}
        </button>
        {showOutputs && audioOutputs.map(name => (
          <button
            key={name}
            className="secret-menu-item"
            style={{ paddingLeft: 24, color: name === currentOutput ? 'var(--accent)' : 'var(--text)' }}
            onClick={() => { hapticTick(); switchOutput(name) }}
          >
            {name === currentOutput ? '● ' : '  '}{name}
          </button>
        ))}

        <button className="secret-menu-item" onClick={() => {
          hapticTick()
          if (!showBt) {
            fetch('/api/bluetooth-devices').then(r => r.json()).then(d => setBtDevices(d.devices || [])).catch(() => {})
          }
          setShowBt(!showBt)
        }}>
          Bluetooth
        </button>
        {showBt && btDevices.map(d => {
          const hasSplit = d.batteryLeft != null && d.batteryRight != null
          const batText = hasSplit
            ? `L${d.batteryLeft} R${d.batteryRight}${d.batteryCase != null ? ` C${d.batteryCase}` : ''}`
            : (d.battery != null ? `${d.battery}%` : '')
          const lowest = hasSplit ? Math.min(d.batteryLeft, d.batteryRight) : d.battery
          const batColor = lowest != null && lowest <= 20 ? 'var(--red)' : 'var(--text-dim)'
          return (
            <button
              key={d.address}
              className="secret-menu-item"
              style={{ paddingLeft: 24, color: d.connected ? 'var(--accent)' : 'var(--text)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              onClick={() => {
                hapticThump()
                const action = d.connected ? 'disconnect' : 'connect'
                fetch(`/api/bluetooth-${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: d.address }) })
                  .then(r => r.json()).then(res => {
                    addToast(res.ok ? `${action === 'connect' ? 'Connected' : 'Disconnected'} ${d.name}` : 'Failed')
                    fetch('/api/bluetooth-devices').then(r => r.json()).then(dd => setBtDevices(dd.devices || [])).catch(() => {})
                  }).catch(() => addToast('Failed'))
              }}
            >
              <span>{d.connected ? '● ' : '  '}{d.name}</span>
              {batText && <span style={{ fontSize: 'var(--font-sm)', color: batColor }}>{batText}</span>}
            </button>
          )
        })}

        {useUIStore.getState().filteredVideos.length > 0 && (
          <button className="secret-menu-item" onClick={() => {
            hapticTick()
            useUIStore.getState().setTab('filtered')
            toggleSecretMenu()
          }}>
            Filtered ({useUIStore.getState().filteredVideos.length})
          </button>
        )}

        {/* The slider only matters when audio is actually being served to
            the phone (sync mode or phone-only). Hide it otherwise to keep
            the menu scannable. */}
        {phoneOpen && <SyncOffsetSlider />}
        <button className="secret-menu-item" onClick={() => {
          hapticTick()
          fetch('/api/toggle-resolution', { method: 'POST' }).then(() => addToast('Resolution toggled')).catch(() => addToast('Toggle failed'))
          toggleSecretMenu()
        }}>
          Toggle resolution
        </button>
        <FindMyToggle onAfter={toggleSecretMenu} addToast={addToast} />

        {/* Misc submenu — stuff that matters less often. Collapsed by default
            to keep the top-level menu scannable. */}
        <button className="secret-menu-item" onClick={() => { hapticTick(); setShowMisc(!showMisc) }}>
          Misc {showMisc ? '▾' : '▸'}
        </button>
        {showMisc && (
          <>
            <FontSizeScrubber value={fontSize} onChange={(n) => { setFontSize(n); applyFontSize(n) }} />
            <button className="secret-menu-item" style={{ paddingLeft: 24 }} onClick={() => { hapticTick(); setShowFonts(!showFonts) }}>
              Font: {fontSel}
            </button>
            {showFonts && FONTS.map(([label, family]) => (
              <button
                key={label}
                className="secret-menu-item"
                style={{ paddingLeft: 40, fontFamily: family, color: label === fontSel ? 'var(--green)' : 'var(--text)' }}
                onClick={() => { hapticTick(); applyFont(label); setFontSel(label) }}
              >
                {label === fontSel ? '● ' : '  '}{label}
              </button>
            ))}
            <div style={{ paddingLeft: 24 }}><GridStyleToggle onAfter={toggleSecretMenu} /></div>
            <button className="secret-menu-item" style={{ paddingLeft: 24 }} onClick={() => {
              hapticTick()
              fetch('/api/refresh-cookies', { method: 'POST' }).then(() => addToast('Cookies refreshed')).catch(() => addToast('Refresh failed'))
              toggleSecretMenu()
            }}>
              Refresh cookies
            </button>
            {isNativeIOS && (
              <button className="secret-menu-item" style={{ paddingLeft: 24 }} onClick={() => { hapticTick(); NativePlayer.showAirPlayPicker() }}>
                AirPlay...
              </button>
            )}
          </>
        )}

        <button className="secret-menu-item" onClick={() => {
          hapticThump()
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
          hapticThump()
          const next = !macStatus.keepAwake
          fetch('/api/keep-awake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enable: next }) })
            .then(() => addToast(next ? 'Keep awake on' : 'Keep awake off'))
            .catch(() => addToast('Keep awake failed'))
        }}>
          Keep awake {macStatus.keepAwake ? '✓' : ''}
        </button>
        <button className="secret-menu-item" onClick={() => { hapticTick(); toggleSecretMenu() }} style={{ color: 'var(--accent2)' }}>
          Close
        </button>
      </div>
    </>
  )
}
