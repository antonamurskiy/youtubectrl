import { useEffect, useRef } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { isNativeIOS } from '../native/player'

const cap = typeof window !== 'undefined' ? window.Capacitor : null

// Fires a local iOS notification when Claude enters the "waiting" state while
// the app is backgrounded, so you can respond without keeping YouTubeCtrl open.
export function useClaudeNotification() {
  const lastStateRef = useRef(null)
  const permissionChecked = useRef(false)

  useEffect(() => {
    if (!isNativeIOS) return
    // Request permission once (iOS remembers after first grant/deny)
    if (!permissionChecked.current) {
      permissionChecked.current = true
      cap?.Plugins?.LocalNotifications?.requestPermissions?.().catch(() => {})
    }

    const unsub = usePlaybackStore.subscribe((state) => {
      const curr = state.claudeState
      const prev = lastStateRef.current
      lastStateRef.current = curr
      if (prev === curr) return
      if (curr !== 'waiting') return
      // Only notify when backgrounded
      if (document.visibilityState === 'visible') return
      const plugin = cap?.Plugins?.LocalNotifications
      if (!plugin) return
      plugin.schedule({
        notifications: [{
          id: 4242, // fixed id — replaces any prior notification
          title: 'Claude is waiting',
          body: state.claudeQuestion || 'Open YouTubeCtrl to respond.',
          schedule: { at: new Date(Date.now() + 100) },
          sound: 'default',
        }],
      }).catch(() => {})
    })
    return unsub
  }, [])
}
