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
function GridStyleToggle({ onAfter, paddingLeft = 12 }) {
  const gridStyle = useUIStore(s => s.gridStyle)
  const setGridStyle = useUIStore(s => s.setGridStyle)
  const next = gridStyle === 'wide' ? 'compact' : 'wide'
  const isWide = gridStyle === 'wide'
  return (
    <button
      className="secret-menu-item"
      style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft }}
      onClick={() => {
        hapticTick()
        setGridStyle(next)
        onAfter?.()
      }}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
        {isWide ? (
          // Wide: three full-width stacked rectangles
          <>
            <rect x="4" y="4" width="16" height="4" />
            <rect x="4" y="10" width="16" height="4" />
            <rect x="4" y="16" width="16" height="4" />
          </>
        ) : (
          // Compact: small thumb + info-row suggestion (left square + two lines)
          <>
            <rect x="4" y="6" width="6" height="5" />
            <line x1="12" y1="7" x2="20" y2="7" />
            <line x1="12" y1="10" x2="17" y2="10" />
            <rect x="4" y="14" width="6" height="5" />
            <line x1="12" y1="15" x2="20" y2="15" />
            <line x1="12" y1="18" x2="17" y2="18" />
          </>
        )}
      </svg>
      Grid: {isWide ? 'wide' : 'compact'}
    </button>
  )
}

// Find My (macOS app) reopen — quits and relaunches each tap so the
// window comes back fresh (map reset, location panel re-fetched).
// Label reflects whether it's currently running so the user knows what
// they're doing. Does NOT close the secret menu — user often wants to
// reopen, then hit another menu item (e.g. Toggle resolution for the
// laptop screen).
// Top slot: volume slider by default; flips to Maria's map crop when
// the Maria sub-row is tapped. FindMyToggle dispatches a
// `maria-map-toggle` window event to flip the state.
function VolumeOrMap({ volume, volAreaRef }) {
  const [showMap, setShowMap] = useState(false)
  const [cropUrl, setCropUrl] = useState(null)
  useEffect(() => {
    const onToggle = (e) => {
      setShowMap(v => !v)
      if (e.detail?.cropUrl) setCropUrl(e.detail.cropUrl)
    }
    // On a refresh tick (↻), re-fetch so the displayed map crop
    // updates even while it's currently showing. Without this the
    // image was frozen to whatever URL we grabbed at first toggle.
    const onRefresh = () => {
      setTimeout(() => {
        fetch('/api/findmy-friend?name=mchimishkyan&force=1')
          .then(r => r.json())
          .then(d => { if (d?.cropUrl) setCropUrl(d.cropUrl) })
          .catch(() => {})
      }, 1800)
    }
    window.addEventListener('maria-map-toggle', onToggle)
    window.addEventListener('findmy-refresh', onRefresh)
    return () => {
      window.removeEventListener('maria-map-toggle', onToggle)
      window.removeEventListener('findmy-refresh', onRefresh)
    }
  }, [])
  if (showMap && cropUrl) {
    // Use background-image rather than <img> — an <img> has an
    // intrinsic width (900px) that WebKit occasionally uses to
    // calculate the shrink-to-fit width of the fixed-position menu,
    // pushing past max-width on repeat toggles. A <div> with a
    // background has no intrinsic size and always respects its
    // container width.
    return (
      <div
        className="secret-menu-item"
        style={{
          padding: 0,
          height: 200,
          backgroundImage: `url(${cropUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        }}
      />
    )
  }
  return (
    <div className="secret-menu-item vol-area" ref={volAreaRef}>
      <div className="vol-fill" style={{ height: `${volume}%` }} />
      <div className="vol-label">{volume}%</div>
    </div>
  )
}

// Parse "6 mi" / "800 ft" / "500 m" / "1.2 km" / "350 yd" → miles.
// Returns Infinity for unparseable inputs so the caller's
// < threshold comparison is safely false-y.
function parseDistanceMiles(s) {
  if (!s) return Infinity
  const m = String(s).trim().match(/^([\d.]+)\s*(mi|km|ft|m|yd)\b/i)
  if (!m) return Infinity
  const n = parseFloat(m[1])
  switch (m[2].toLowerCase()) {
    case 'mi': return n
    case 'km': return n * 0.621371
    case 'ft': return n / 5280
    case 'm':  return n / 1609.34
    case 'yd': return n / 1760
    default:   return Infinity
  }
}

function formatAge(ms) {
  if (ms == null || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// Find My — primary button toggles open/close (app quits on close).
// When running, a trailing ↻ refreshes location by hiding+reactivating
// the app (cheap re-poll, no relaunch). Secret menu stays open.
// Sub-row below shows Maria's nearest cross street via OCR on the
// laptop display (Find My must be visible there — done by the open
// action).
function FindMyToggle({ addToast }) {
  const [running, setRunning] = useState(null)
  const [friend, setFriend] = useState(null)
  const [stealth, setStealth] = useState(false)
  useEffect(() => {
    fetch('/api/findmy-status').then(r => r.json()).then(d => setRunning(!!d.running)).catch(() => setRunning(false))
    fetch('/api/findmy-stealth').then(r => r.json()).then(d => setStealth(!!d.on)).catch(() => {})
  }, [])
  useEffect(() => {
    if (!running) { setFriend(null); return }
    const fetchFriend = () => fetch('/api/findmy-friend?name=mchimishkyan').then(r => r.json()).then(setFriend).catch(() => {})
    fetchFriend()
    const iv = setInterval(fetchFriend, 60000)
    return () => clearInterval(iv)
  }, [running])

  const label = running == null ? 'Find My…' : (running ? 'Close Find My' : 'Show Find My')
  const color = running ? 'var(--green)' : 'var(--text-dim)'
  return (
    <>
      <div style={{ display: 'flex' }}>
        <button
          className="secret-menu-item"
          style={{ color, display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}
          onClick={() => {
            hapticTick()
            fetch('/api/toggle-findmy', { method: 'POST' })
              .then(r => r.json())
              .then(d => { setRunning(!!d.running); addToast(d.running ? 'Find My shown' : 'Find My closed') })
              .catch(() => addToast('Find My failed'))
          }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
            <path d="M12 22s-7-7.58-7-12a7 7 0 0 1 14 0c0 4.42-7 12-7 12z" />
            <circle cx="12" cy="10" r="2.5" />
          </svg>
          {label}
        </button>
        {running && (
          <button
            className="secret-menu-item"
            style={{ color: stealth ? 'var(--text-dim)' : 'var(--green)', display: 'flex', alignItems: 'center', width: 'auto', paddingLeft: 12, paddingRight: 12, borderLeft: '1px solid var(--border)' }}
            aria-label={stealth ? 'Show Find My on laptop screen' : 'Hide Find My off-screen (stealth)'}
            onClick={() => {
              hapticTick()
              const next = !stealth
              fetch('/api/findmy-stealth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: next }) })
                .then(() => { setStealth(next); addToast(next ? 'Find My stealth on' : 'Find My visible') })
                .catch(() => addToast('Stealth toggle failed'))
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
              {stealth ? (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </>
              ) : (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
          </button>
        )}
        {running && (
          <button
            className="secret-menu-item"
            style={{ color: 'var(--green)', display: 'flex', alignItems: 'center', width: 'auto', paddingLeft: 16, paddingRight: 16, borderLeft: '1px solid var(--border)' }}
            aria-label="Refresh Find My locations"
            onClick={() => {
              hapticTick()
              fetch('/api/refresh-findmy', { method: 'POST' })
                .then(() => addToast('Find My refreshed'))
                .catch(() => addToast('Refresh failed'))
              // Signal both FindMyToggle's sub-row AND the top-of-menu
              // MariaMap to re-fetch after Find My re-polls + renders.
              setTimeout(() => {
                fetch('/api/findmy-friend?name=mchimishkyan&force=1').then(r => r.json()).then(setFriend).catch(() => {})
                window.dispatchEvent(new Event('findmy-refresh'))
              }, 1500)
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
          </button>
        )}
      </div>
      {friend?.ok && (
        <div
          className="secret-menu-item"
          style={{ paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 2, fontSize: 'var(--font-sm)', cursor: friend.cropUrl ? 'pointer' : 'default' }}
          onClick={() => {
            if (!friend.cropUrl) return
            hapticTick()
            window.dispatchEvent(new CustomEvent('maria-map-toggle', { detail: { cropUrl: friend.cropUrl } }))
          }}
        >
          <div style={{ color: 'var(--text)' }}>
            Maria: {friend.crossStreet || friend.address || '—'}
            {friend.distance ? <span style={{ color: 'var(--text-dim)' }}>{' · '}{friend.distance}</span> : null}
          </div>
          <div style={{ color: (friend.ageMs != null && friend.ageMs > 10 * 60 * 1000) ? 'var(--red)' : 'var(--text-dim)' }}>
            {friend.timeFragment ? `Last ping: ${friend.timeFragment}` : (friend.ageMs != null ? `Last ping: ${formatAge(friend.ageMs)}` : '')}
          </div>
        </div>
      )}
    </>
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
        <VolumeOrMap volume={volume} volAreaRef={volAreaRef} />

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
        <FindMyToggle addToast={addToast} />

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
            <GridStyleToggle onAfter={toggleSecretMenu} paddingLeft={24} />
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
