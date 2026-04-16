import { useEffect, useRef, useState } from 'react'

// Rubber-band resistance curve — raw distance → banded distance.
// Matches iOS-ish feel: feels natural up to threshold, then
// progressively stiffer beyond. Never exceeds MAX.
function band(dy, threshold) {
  const MAX = threshold * 2
  // Tangent-based resistance: asymptotically approaches MAX
  const banded = (MAX * 2 / Math.PI) * Math.atan((dy / threshold) * (Math.PI / 2))
  return Math.max(0, Math.min(MAX, banded))
}

// Pull-to-refresh: when the page is scrolled to top and the user drags down
// past the threshold, fires onRefresh(). Returns { translateY, armed } for the
// caller to render a banded indicator.
export function usePullToRefresh({ onRefresh, threshold = 70, enabled = true }) {
  const [state, setState] = useState({ translateY: 0, armed: false, active: false })
  const startYRef = useRef(null)
  const dyRef = useRef(0)
  const didHapticRef = useRef(false)
  const firedRef = useRef(false)

  useEffect(() => {
    if (!enabled) return

    const onStart = (e) => {
      if (window.scrollY > 0) return
      const t = e.touches?.[0]
      if (!t) return
      startYRef.current = t.clientY
      dyRef.current = 0
      didHapticRef.current = false
      firedRef.current = false
    }

    const onMove = (e) => {
      if (startYRef.current == null) return
      const t = e.touches?.[0]
      if (!t) return
      const rawDy = t.clientY - startYRef.current
      if (rawDy <= 0) {
        if (state.active) setState({ translateY: 0, armed: false, active: false })
        return
      }
      if (window.scrollY > 0) {
        startYRef.current = null
        if (state.active) setState({ translateY: 0, armed: false, active: false })
        return
      }
      dyRef.current = rawDy
      const translateY = band(rawDy, threshold)
      const armed = rawDy >= threshold
      setState({ translateY, armed, active: true })
      if (!didHapticRef.current && armed) {
        didHapticRef.current = true
        import('../haptics').then(m => m.thump()).catch(() => {})
      } else if (didHapticRef.current && !armed) {
        didHapticRef.current = false
      }
    }

    const onEnd = () => {
      if (startYRef.current == null) return
      const armed = dyRef.current >= threshold
      startYRef.current = null
      dyRef.current = 0
      setState({ translateY: 0, armed: false, active: false })
      if (armed && !firedRef.current) {
        firedRef.current = true
        onRefresh?.()
      }
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onEnd)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [onRefresh, threshold, enabled, state.active])

  return state
}
