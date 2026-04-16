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

// Selection-style haptic for smooth sliders — lighter than tick(),
// doesn't spam on rapid changes (iOS limits it internally)
const cap = typeof window !== 'undefined' ? window.Capacitor : null
export function selection() {
  if (!isNativeIOS) return
  try { cap?.Plugins?.Haptics?.selectionChanged() } catch {}
}
export function selectionStart() {
  if (!isNativeIOS) return
  try { cap?.Plugins?.Haptics?.selectionStart() } catch {}
}
export function selectionEnd() {
  if (!isNativeIOS) return
  try { cap?.Plugins?.Haptics?.selectionEnd() } catch {}
}
