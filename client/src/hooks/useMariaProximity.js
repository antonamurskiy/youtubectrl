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
    let ival
    const tick = async () => {
      if (!alive) return
      // Skip while tab isn't visible — the OCR pipeline is expensive
      // (screenshot + Swift Vision + up to 2 retries). Polling when
      // the app's backgrounded is pure waste.
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        const status = await fetch('/api/findmy-status').then(r => r.json())
        if (!status?.running) {
          document.body.classList.remove('maria-proximity')
          stickyRef.current = false
          return
        }
        const friend = await fetch('/api/findmy-friend?name=mchimishkyan').then(r => r.json())
        if (!friend?.ok) return
        const miles = parseDistanceMiles(friend.distance)
        if (miles < 1) {
          stickyRef.current = true
          document.body.classList.add('maria-proximity')
        } else if (Number.isFinite(miles) && miles >= 1) {
          stickyRef.current = false
          document.body.classList.remove('maria-proximity')
        }
        // unparseable (null/Infinity) → leave state as-is
      } catch {}
    }
    tick()
    ival = setInterval(tick, 60000)
    return () => {
      alive = false
      clearInterval(ival)
      document.body.classList.remove('maria-proximity')
    }
  }, [])
}
