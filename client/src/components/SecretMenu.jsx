import { useState, useRef, useCallback, useEffect } from 'react'
import { useUIStore } from '../stores/ui'

export default function SecretMenu() {
  const toggleSecretMenu = useUIStore(s => s.toggleSecretMenu)
  const addToast = useUIStore(s => s.addToast)
  const [volume, setVolume] = useState(50)
  const volAreaRef = useRef(null)
  const draggingRef = useRef(false)

  // Fetch current volume on mount
  useEffect(() => {
    // No dedicated GET endpoint for volume in the original, default to 50
  }, [])

  const updateVolume = useCallback((clientY) => {
    const el = volAreaRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const y = Math.max(0, Math.min(clientY - rect.top, rect.height))
    const vol = Math.round(100 - (y / rect.height) * 100)
    setVolume(vol)

    fetch('/api/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: vol }),
    }).catch(() => {})
  }, [])

  const handlePointerDown = useCallback((e) => {
    e.preventDefault()
    draggingRef.current = true
    updateVolume(e.clientY)

    const handleMove = (ev) => {
      if (draggingRef.current) updateVolume(ev.clientY)
    }
    const handleUp = () => {
      draggingRef.current = false
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
    }

    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
  }, [updateVolume])

  const handleToggleResolution = useCallback(() => {
    fetch('/api/toggle-resolution', { method: 'POST' })
      .then(() => addToast('Resolution toggled'))
      .catch(() => addToast('Toggle failed'))
    toggleSecretMenu()
  }, [addToast, toggleSecretMenu])

  const handleRefreshCookies = useCallback(() => {
    fetch('/api/refresh-cookies', { method: 'POST' })
      .then(() => addToast('Cookies refreshed'))
      .catch(() => addToast('Refresh failed'))
    toggleSecretMenu()
  }, [addToast, toggleSecretMenu])

  return (
    <>
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 599 }}
        onClick={toggleSecretMenu}
      />
      <div className="secret-menu">
        {/* Volume slider area */}
        <div
          className="secret-menu-item vol-area"
          ref={volAreaRef}
          onPointerDown={handlePointerDown}
        >
          <div className="vol-fill" style={{ height: `${volume}%` }} />
          <div className="vol-label">{volume}%</div>
        </div>

        <button className="secret-menu-item" onClick={() => { fetch('/api/mute', { method: 'POST' }).then(() => addToast('Mute toggled')).catch(() => addToast('Mute failed')) }}>
          Toggle mute
        </button>
        <button className="secret-menu-item" onClick={handleToggleResolution}>
          Toggle resolution
        </button>
        <button className="secret-menu-item" onClick={handleRefreshCookies}>
          Refresh cookies
        </button>
        <button className="secret-menu-item" onClick={toggleSecretMenu} style={{ color: 'var(--accent2)' }}>
          Close
        </button>
      </div>
    </>
  )
}
