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

// Consistent 16×16 stroke-based icon. Children are the SVG inner
// paths/shapes. Matches the style used elsewhere in the app.
function Ico({ children }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" style={{ flexShrink: 0 }}>
      {children}
    </svg>
  )
}
const ICON_BTN_STYLE = { display: 'flex', alignItems: 'center', gap: 8 }

// Audio icon that swaps shape with the connected device:
//   AirPods / earbuds      — two vertical stems with ear tips
//   Over-ear headphones    — band + L/R cups (BlackShark, Beats, etc.)
//   Speaker (fallback)     — cone with sound wave (LG UltraFine, MacBook)
// Name matching is substring, case-insensitive. Matching is intentionally
// liberal so unknown earbuds still pick the right family.
export function AudioOutputIcon({ name }) {
  const n = (name || '').toLowerCase()
  const isEarbuds = /airpod|earbud|buds|pods/.test(n)
  const isOverEar = /blackshark|beats|headphone|wh-|qc\d|razer|logitech|ath-|steelseries|hyperx|bose/.test(n)
  return (
    <Ico>
      {isEarbuds ? (
        // AirPods: bulb (ear tip) + stem + flared mic at the bottom.
        // Two of them, mirrored. Drawn as paths so the silhouette
        // reads at 16px.
        <>
          <path d="M7 3 a3 3 0 0 1 3 3 c0 3 -1 4 -2 4.5 v8 a1.5 1.5 0 0 1 -3 0 v-8 c-1 -0.5 -2 -1.5 -2 -4.5 a3 3 0 0 1 2 -3 z" />
          <path d="M17 3 a3 3 0 0 0 -3 3 c0 3 1 4 2 4.5 v8 a1.5 1.5 0 0 0 3 0 v-8 c1 -0.5 2 -1.5 2 -4.5 a3 3 0 0 0 -2 -3 z" />
        </>
      ) : isOverEar ? (
        // Over-ear: arc band + two cup rectangles
        <>
          <path d="M3 15 v-3 a9 9 0 0 1 18 0 v3" />
          <rect x="2" y="14" width="5" height="7" rx="1" />
          <rect x="17" y="14" width="5" height="7" rx="1" />
        </>
      ) : (
        // Speaker cone + wave
        <>
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        </>
      )}
    </Ico>
  )
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
  const [refreshing, setRefreshing] = useState(false)
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
              .then(d => {
                setRunning(!!d.running)
                addToast(d.running ? 'Find My shown' : 'Find My closed')
                // Notify useMariaProximity so it re-checks state
                // immediately instead of waiting for the 60s poll —
                // red wash should clear the moment Find My closes.
                window.dispatchEvent(new Event('findmy-state-changed'))
              })
              .catch((e) => { console.error('Find My toggle error:', e); addToast(`Find My: ${e?.message || 'failed'}`) })
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
            disabled={refreshing}
            onClick={() => {
              if (refreshing) return
              hapticTick()
              setRefreshing(true)
              // Server work: hide + 300ms + activate + (stealth-aware re-hide).
              // Then client re-fetches the friend payload for both the text row
              // and the map crop. Spinner runs until all of it resolves.
              const serverWork = fetch('/api/refresh-findmy', { method: 'POST' })
                .then(() => addToast('Find My refreshed'))
                .catch(() => addToast('Refresh failed'))
              const clientRefetch = new Promise(r => setTimeout(r, 1500))
                .then(() => fetch('/api/findmy-friend?name=mchimishkyan&force=1')
                  .then(rr => rr.json()).then(setFriend).catch(() => {}))
                .then(() => window.dispatchEvent(new Event('findmy-refresh')))
              Promise.all([serverWork, clientRefetch]).finally(() => setRefreshing(false))
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" className={refreshing ? 'spin' : undefined}>
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

// Display brightness scrubber. Drives the display mpv is currently on
// (server picks via `currentMonitor`). Same fill-bar style as the font
// size scrubber so it sits nicely in the Misc submenu.
function BrightnessScrubber() {
  const [value, setValue] = useState(null) // 0..100, null until first GET
  const ref = useRef(null)
  const draggingRef = useRef(false)
  const inFlightRef = useRef(false)
  const pendingRef = useRef(null)
  const lastSentRef = useRef(null)
  const lastHapticRef = useRef(-1)

  useEffect(() => {
    let stale = false
    fetch('/api/brightness')
      .then(r => r.json())
      .then(d => { if (!stale && d.brightness != null) setValue(Math.round(d.brightness * 100)) })
      .catch(() => {})
    return () => { stale = true }
  }, [])

  const send = useCallback(() => {
    if (inFlightRef.current || pendingRef.current == null) return
    const v = pendingRef.current
    pendingRef.current = null
    if (lastSentRef.current === v) return
    lastSentRef.current = v
    inFlightRef.current = true
    fetch('/api/brightness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: v / 100 }),
    }).catch(() => {}).finally(() => {
      inFlightRef.current = false
      if (pendingRef.current != null) send()
    })
  }, [])

  const update = useCallback((clientX) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width))
    const v = Math.round((x / rect.width) * 100)
    setValue(v)
    pendingRef.current = v
    send()
    const step = Math.floor(v / 5)
    if (step !== lastHapticRef.current) {
      lastHapticRef.current = step
      hapticSelection()
    }
  }, [send])

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

  const pct = value == null ? 0 : value
  return (
    <div className="secret-menu-item size-area" ref={ref}>
      <div className="size-fill" style={{ width: `${pct}%` }} />
      <div className="size-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
          <circle cx="12" cy="12" r="4" />
          <line x1="12" y1="2" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="22" />
          <line x1="2" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="22" y2="12" />
          <line x1="4.93" y1="4.93" x2="7.05" y2="7.05" />
          <line x1="16.95" y1="16.95" x2="19.07" y2="19.07" />
          <line x1="4.93" y1="19.07" x2="7.05" y2="16.95" />
          <line x1="16.95" y1="7.05" x2="19.07" y2="4.93" />
        </svg>
        <span>{value == null ? '…' : `${value}%`}</span>
      </div>
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
            ...ICON_BTN_STYLE,
            color: muted ? 'var(--red)' : 'var(--text)',
            background: muted ? 'rgba(255,50,50,0.1)' : 'none',
          }}
          onClick={() => {
            hapticThump()
            fetch('/api/mute', { method: 'POST' }).then(r => r.json()).then(d => { setMuted(d.muted); addToast(d.muted ? 'Muted' : 'Unmuted') }).catch(() => addToast('Mute failed'))
          }}
        >
          <Ico>
            {muted ? (
              <>
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </>
            ) : (
              <>
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </>
            )}
          </Ico>
          {muted ? 'Muted' : 'Mute'}
        </button>

        <button className="secret-menu-item" style={ICON_BTN_STYLE} onClick={() => { hapticTick(); setShowOutputs(!showOutputs) }}>
          <AudioOutputIcon name={currentOutput} />
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

        <button className="secret-menu-item" style={ICON_BTN_STYLE} onClick={() => {
          hapticTick()
          if (!showBt) {
            fetch('/api/bluetooth-devices').then(r => r.json()).then(d => setBtDevices(d.devices || [])).catch(() => {})
          }
          setShowBt(!showBt)
        }}>
          <Ico>
            <polyline points="6 7 18 17 12 22 12 2 18 7 6 17" />
          </Ico>
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
          <button className="secret-menu-item" style={ICON_BTN_STYLE} onClick={() => {
            hapticTick()
            useUIStore.getState().setTab('filtered')
            toggleSecretMenu()
          }}>
            <Ico>
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </Ico>
            Filtered ({useUIStore.getState().filteredVideos.length})
          </button>
        )}

        {/* The slider only matters when audio is actually being served to
            the phone (sync mode or phone-only). Hide it otherwise to keep
            the menu scannable. */}
        {phoneOpen && <SyncOffsetSlider />}
        <button className="secret-menu-item" style={ICON_BTN_STYLE} onClick={() => {
          hapticTick()
          fetch('/api/toggle-resolution', { method: 'POST' }).then(() => addToast('Resolution toggled')).catch(() => addToast('Toggle failed'))
          toggleSecretMenu()
        }}>
          <Ico>
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </Ico>
          Toggle resolution
        </button>
        <FindMyToggle addToast={addToast} />

        {/* Misc submenu — stuff that matters less often. Collapsed by default
            to keep the top-level menu scannable. */}
        <button className="secret-menu-item" style={ICON_BTN_STYLE} onClick={() => { hapticTick(); setShowMisc(!showMisc) }}>
          <Ico>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </Ico>
          <span style={{ flex: 1 }}>Misc</span>
          <span style={{ color: 'var(--text-dim)' }}>{showMisc ? '▾' : '▸'}</span>
        </button>
        {showMisc && (
          <>
            <BrightnessScrubber />
            <FontSizeScrubber value={fontSize} onChange={(n) => { setFontSize(n); applyFontSize(n) }} />
            <button className="secret-menu-item" style={{ ...ICON_BTN_STYLE, paddingLeft: 24 }} onClick={() => { hapticTick(); setShowFonts(!showFonts) }}>
              <Ico>
                <polyline points="4 7 4 4 20 4 20 7" />
                <line x1="9" y1="20" x2="15" y2="20" />
                <line x1="12" y1="4" x2="12" y2="20" />
              </Ico>
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
            <button className="secret-menu-item" style={{ ...ICON_BTN_STYLE, paddingLeft: 24 }} onClick={() => {
              hapticTick()
              fetch('/api/refresh-cookies', { method: 'POST' }).then(() => addToast('Cookies refreshed')).catch(() => addToast('Refresh failed'))
              toggleSecretMenu()
            }}>
              <Ico>
                <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
              </Ico>
              Refresh cookies
            </button>
            {isNativeIOS && (
              <button className="secret-menu-item" style={{ ...ICON_BTN_STYLE, paddingLeft: 24 }} onClick={() => { hapticTick(); NativePlayer.showAirPlayPicker() }}>
                <Ico>
                  <path d="M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1" />
                  <polygon points="12 15 17 21 7 21 12 15" />
                </Ico>
                AirPlay...
              </button>
            )}
            <button
              className="secret-menu-item"
              style={{ ...ICON_BTN_STYLE, paddingLeft: 24 }}
              onClick={() => {
                hapticThump()
                fetch('/api/focus-cmux', { method: 'POST' })
                  .then(() => addToast('Focus cmux'))
                  .catch(() => addToast('Focus failed'))
                toggleSecretMenu()
              }}
            >
              <Ico>
                <rect x="2" y="3" width="20" height="18" rx="2" />
                <polyline points="6 9 10 13 6 17" />
                <line x1="14" y1="17" x2="18" y2="17" />
              </Ico>
              Focus cmux
            </button>
          </>
        )}

        <button className="secret-menu-item" style={ICON_BTN_STYLE} onClick={() => {
          hapticThump()
          const wake = macStatus.screenOff
          const endpoint = wake ? '/api/wake-mac' : '/api/lock-mac'
          const okMsg = wake ? 'Waking' : 'Mac locked'
          const failMsg = wake ? 'Wake failed' : 'Lock failed'
          fetch(endpoint, { method: 'POST' }).then(() => addToast(okMsg)).catch(() => addToast(failMsg))
          toggleSecretMenu()
        }}>
          <Ico>
            {macStatus.screenOff ? (
              <>
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </>
            ) : (
              <>
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </>
            )}
          </Ico>
          {macStatus.screenOff ? 'Wake Mac' : 'Lock Mac'}
        </button>
        <button className="secret-menu-item" style={{ ...ICON_BTN_STYLE, color: macStatus.keepAwake ? 'var(--green)' : undefined }} onClick={() => {
          hapticThump()
          const next = !macStatus.keepAwake
          fetch('/api/keep-awake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enable: next }) })
            .then(() => addToast(next ? 'Keep awake on' : 'Keep awake off'))
            .catch(() => addToast('Keep awake failed'))
        }}>
          <Ico>
            {/* Coffee cup — classic "stay awake" signal */}
            <path d="M18 8h1a4 4 0 0 1 0 8h-1" />
            <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" />
            <line x1="6" y1="1" x2="6" y2="4" />
            <line x1="10" y1="1" x2="10" y2="4" />
            <line x1="14" y1="1" x2="14" y2="4" />
          </Ico>
          <span style={{ flex: 1 }}>Keep awake</span>
          {macStatus.keepAwake && <span>✓</span>}
        </button>
        <button className="secret-menu-item" style={{ ...ICON_BTN_STYLE, color: 'var(--accent2)' }} onClick={() => { hapticTick(); toggleSecretMenu() }}>
          <Ico>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </Ico>
          Close
        </button>
      </div>
    </>
  )
}
