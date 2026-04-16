import { useEffect, useRef, useState } from 'react'

// iOS-style rubber-band resistance curve.
function band(dy, threshold) {
  const MAX = threshold * 2
  return (MAX * 2 / Math.PI) * Math.atan((dy / threshold) * (Math.PI / 2))
}

// Pull-to-refresh. Directly mutates the DOM in a requestAnimationFrame loop —
// doing this via React setState on every touchmove is too slow on iOS and
// causes jank. We use refs for everything on the hot path and only setState
// when the "armed" state flips (for re-rendering the label colour).
export function usePullToRefresh({
  onRefresh,
  threshold = 70,
  enabled = true,
  bodyEl,      // () => HTMLElement — the content container to translate
  indicatorEl, // () => HTMLElement — the overlay with PULL/RELEASE text
}) {
  const [armed, setArmed] = useState(false)

  const startYRef = useRef(null)
  const rawDyRef = useRef(0)
  const translateRef = useRef(0)
  const rafRef = useRef(null)
  const didHapticRef = useRef(false)
  const firedRef = useRef(false)
  const settlingRef = useRef(false)

  useEffect(() => {
    if (!enabled) return

    const getBody = () => bodyEl?.()
    const getIndicator = () => indicatorEl?.()

    const writeFrame = () => {
      rafRef.current = null
      const body = getBody()
      const ind = getIndicator()
      const y = translateRef.current
      if (body) body.style.transform = y > 0 ? `translate3d(0,${y}px,0)` : ''
      if (ind) {
        ind.style.height = `${y}px`
        ind.style.opacity = Math.min(1, y / 20)
      }
    }
    const schedule = () => {
      if (rafRef.current != null) return
      rafRef.current = requestAnimationFrame(writeFrame)
    }

    const reset = (animate) => {
      settlingRef.current = animate
      const body = getBody()
      const ind = getIndicator()
      translateRef.current = 0
      if (body) {
        body.style.transition = animate ? 'transform 0.22s cubic-bezier(.2,.8,.2,1)' : ''
        body.style.transform = ''
      }
      if (ind) {
        ind.style.transition = animate ? 'height 0.22s cubic-bezier(.2,.8,.2,1), opacity 0.22s' : ''
        ind.style.height = '0px'
        ind.style.opacity = '0'
      }
      if (animate) {
        setTimeout(() => {
          settlingRef.current = false
          if (body) {
            body.style.transition = ''
            body.style.willChange = '' // remove transform layer — restores fixed positioning
          }
          if (ind) ind.style.transition = ''
        }, 240)
      } else if (body) {
        body.style.willChange = ''
      }
      setArmed(false)
      didHapticRef.current = false
    }

    const onStart = (e) => {
      if (settlingRef.current) return
      if (window.scrollY > 0) return
      const t = e.touches?.[0]
      if (!t) return
      // Ignore touches on interactive/scrollable elements
      const tgt = e.target
      if (tgt?.closest?.('input, textarea, select, [role="slider"], .vol-area, .size-area, .np-progress-bar, .shorts-row, .phone-player')) return
      startYRef.current = t.clientY
      rawDyRef.current = 0
      translateRef.current = 0
      firedRef.current = false
      didHapticRef.current = false
      // Only promote to a compositor layer during the pull — keeping it
      // permanently makes position:fixed descendants relative to this
      // element, which breaks context menus when the page is scrolled.
      const body = getBody()
      if (body) body.style.willChange = 'transform'
    }

    const onMove = (e) => {
      if (startYRef.current == null) return
      const t = e.touches?.[0]
      if (!t) return
      const rawDy = t.clientY - startYRef.current
      // Cancel if the user scrolls back up or if page scrolls
      if (rawDy <= 0 || window.scrollY > 0) {
        startYRef.current = null
        reset(true)
        return
      }
      rawDyRef.current = rawDy
      const ty = band(rawDy, threshold)
      translateRef.current = ty
      const nowArmed = rawDy >= threshold
      if (nowArmed !== armed) {
        setArmed(nowArmed)
      }
      if (nowArmed && !didHapticRef.current) {
        didHapticRef.current = true
        import('../haptics').then(m => m.thump()).catch(() => {})
      } else if (!nowArmed && didHapticRef.current) {
        didHapticRef.current = false
      }
      schedule()
    }

    const onEnd = () => {
      if (startYRef.current == null) return
      const wasArmed = rawDyRef.current >= threshold
      startYRef.current = null
      rawDyRef.current = 0
      reset(true)
      if (wasArmed && !firedRef.current) {
        firedRef.current = true
        onRefresh?.()
      }
    }

    const onCancel = () => {
      startYRef.current = null
      rawDyRef.current = 0
      reset(true)
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onCancel)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [onRefresh, threshold, enabled, armed, bodyEl, indicatorEl])

  return { armed }
}
