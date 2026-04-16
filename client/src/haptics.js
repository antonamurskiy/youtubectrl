import { haptic, isNativeIOS } from './native/player'

export function tick() {
  if (isNativeIOS) { haptic('light'); return }
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(10) } catch {}
  }
}

export function thump() {
  if (isNativeIOS) { haptic('medium'); return }
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(20) } catch {}
  }
}
