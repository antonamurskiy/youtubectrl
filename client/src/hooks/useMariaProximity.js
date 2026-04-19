import { useEffect, useRef } from 'react'

// Poll Maria's location every 60s when Find My is running; if distance
// drops below 1 mile, stain the whole app's background dark red (via
// body.maria-proximity class). Mounted once at the app root so the
// alert fires even when the secret menu is closed.
//
// STICKY: Find My briefly blanks the distance field while its
// location spinner is showing, causing raw distance to flicker null
// on some polls. Latch: once <1mi seen, hold the red wash until we
// see a CONFIRMED reading ≥1mi. Transient nulls don't clear it.
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

export function useMariaProximity() {
  const stickyRef = useRef(false)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (!alive) return
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        const status = await fetch('/api/findmy-status').then(r => r.json())
        if (!status?.running) {
          document.body.classList.remove('maria-proximity')
          stickyRef.current = false
          return
        }
        const friend = await fetch('/api/findmy-friend?name=mchimishkyan').then(r => r.json())
        if (!friend?.ok) {
          // Not-running / not-found / error — treat like Find My is
          // down and clear the wash. Better than leaving the tint on
          // after Maria quits sharing or FM crashes.
          document.body.classList.remove('maria-proximity')
          stickyRef.current = false
          return
        }
        const miles = parseDistanceMiles(friend.distance)
        if (miles < 0.5) {
          stickyRef.current = true
          document.body.classList.add('maria-proximity')
        } else if (Number.isFinite(miles) && miles >= 0.5) {
          stickyRef.current = false
          document.body.classList.remove('maria-proximity')
        }
        // unparseable (null/Infinity) → leave state as-is
      } catch {}
    }
    tick()
    const ival = setInterval(tick, 60000)
    // Re-run the tick on external state-change signals + whenever
    // the app returns to the foreground. Without the visibility hook
    // the red wash could stay un-applied for up to a minute after
    // returning to the app — even though the server has fresh data.
    const onState = () => tick()
    const onVisible = () => { if (!document.hidden) tick() }
    window.addEventListener('findmy-refresh', onState)
    window.addEventListener('findmy-state-changed', onState)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(ival)
      window.removeEventListener('findmy-refresh', onState)
      window.removeEventListener('findmy-state-changed', onState)
      document.removeEventListener('visibilitychange', onVisible)
      document.body.classList.remove('maria-proximity')
    }
  }, [])
}
