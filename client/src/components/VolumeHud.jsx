import { useEffect, useState, useRef } from 'react'

// Floating volume indicator that appears when the user presses physical
// volume buttons (which route through useVolumeButtons → /api/volume-bump).
// Also listens for an in-app custom event so we can update from other paths.
export default function VolumeHud() {
  const [visible, setVisible] = useState(false)
  const [volume, setVolume] = useState(0)
  const hideTimer = useRef(null)

  useEffect(() => {
    const show = (v) => {
      setVolume(v)
      setVisible(true)
      if (hideTimer.current) clearTimeout(hideTimer.current)
      hideTimer.current = setTimeout(() => setVisible(false), 2500)
    }
    const onVol = (e) => show(e.detail?.volume ?? 0)
    window.addEventListener('mac-volume', onVol)
    return () => {
      window.removeEventListener('mac-volume', onVol)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0) + 8px)',
        left: '50%',
        transform: `translateX(-50%) translateY(${visible ? 0 : -30}px)`,
        opacity: visible ? 1 : 0,
        transition: 'transform 0.2s cubic-bezier(.2,.8,.2,1), opacity 0.2s',
        pointerEvents: 'none',
        zIndex: 1000,
        background: 'rgba(21,21,21,0.95)',
        border: '1px solid var(--text-dim)',
        padding: '6px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontFamily: 'var(--font)',
        fontSize: 'var(--font-sm)',
        letterSpacing: '1px',
        color: 'var(--text)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        {volume > 30 && <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />}
        {volume > 65 && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
      </svg>
      <div
        style={{
          width: 120,
          height: 4,
          background: 'var(--surface-hover)',
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: `${volume}%`,
            background: 'var(--accent)',
            transition: 'width 0.1s',
          }}
        />
      </div>
      <span style={{ minWidth: 28, textAlign: 'right', color: 'var(--text-dim)' }}>{volume}%</span>
    </div>
  )
}
