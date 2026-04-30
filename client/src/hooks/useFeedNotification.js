import { useEffect, useRef } from 'react'
import { useSyncStore } from '../stores/sync'
import { isNativeIOS } from '../native/player'

const cap = typeof window !== 'undefined' ? window.Capacitor : null

// While the iOS app is backgrounded, surface kill-feed lines as
// local notifications so the user can keep tabs on what Claude is
// doing without bringing the app foreground. Uses a fixed id so
// each new line REPLACES the previous notification (iOS shows just
// the latest banner instead of a growing stack), and a 1.5s
// coalescing window so a rapid burst of tool calls doesn't spam
// the notification system.
//
// Caveats: when JS is fully suspended (no audio playing, app idle
// past ~30s in background), the WebSocket dies and no feed messages
// arrive — there's nothing to notify on. With audio in background
// or shortly after backgrounding, JS stays alive and this works.
export function useFeedNotification() {
  const lastFeedLenRef = useRef(0)
  const pendingTextRef = useRef(null)
  const flushTimerRef = useRef(null)
  const permissionChecked = useRef(false)

  useEffect(() => {
    if (!isNativeIOS) return
    if (!permissionChecked.current) {
      permissionChecked.current = true
      cap?.Plugins?.LocalNotifications?.requestPermissions?.().catch(() => {})
    }

    const flush = () => {
      flushTimerRef.current = null
      const text = pendingTextRef.current
      pendingTextRef.current = null
      if (!text) return
      const plugin = cap?.Plugins?.LocalNotifications
      if (!plugin) return
      plugin.schedule({
        notifications: [{
          id: 4243, // fixed id — replaces previous feed banner
          title: 'Claude',
          body: text,
          schedule: { at: new Date(Date.now() + 50) },
          sound: null,
        }],
      }).catch(() => {})
    }

    const unsub = useSyncStore.subscribe((state) => {
      const feed = state.claudeFeed
      if (!Array.isArray(feed)) return
      const prevLen = lastFeedLenRef.current
      lastFeedLenRef.current = feed.length
      if (feed.length <= prevLen) return
      // Skip while foregrounded — the in-app overlay already shows
      // the line and a redundant notification banner is noise.
      if (document.visibilityState === 'visible') return
      // Coalesce: keep the LATEST text, defer scheduling 1.5s so a
      // burst of tool calls collapses to one banner.
      const newest = feed[feed.length - 1]
      if (!newest) return
      pendingTextRef.current = newest.text
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      flushTimerRef.current = setTimeout(flush, 1500)
    })

    return () => {
      unsub()
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
    }
  }, [])
}
