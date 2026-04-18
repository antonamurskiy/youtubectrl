import { useEffect, useRef } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import { useUIStore } from '../stores/ui'
import { isNativeIOS, NativePlayer } from '../native/player'

// Hardware volume button interception on native iOS.
//
// Rules:
//   - Phone-only mode (phoneOnlyUrl is set): DO NOT intercept. Leave the
//     phone's volume controls native so the user can control the phone
//     playback directly.
//   - Desktop playing OR sync mode (phone playing alongside mpv): intercept
//     volume button presses and forward them to /api/volume-bump so the
//     user's volume buttons control the Mac's output instead.
export function useVolumeButtons() {
  const phoneOnlyUrl = useSyncStore(s => s.phoneOnlyUrl)
  const phoneOpen = useSyncStore(s => s.phoneOpen)
  const playing = usePlaybackStore(s => s.playing)

  // Decide whether to intercept
  useEffect(() => {
    if (!isNativeIOS) return
    const interceptOn = !!playing && !phoneOnlyUrl
    NativePlayer.setVolumeIntercept(interceptOn).catch(() => {})
    return () => {
      NativePlayer.setVolumeIntercept(false).catch(() => {})
    }
  }, [phoneOnlyUrl, playing])

  const lastBlockedToastRef = useRef(0)

  // Wire incoming volume events
  useEffect(() => {
    if (!isNativeIOS) return
    const handle = NativePlayer.addListener('volumeButton', ({ delta }) => {
      fetch('/api/volume-bump', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta }),
      }).then(r => r.json()).then(d => {
        if (d?.skipped) {
          // Throttle — user mashing volume buttons shouldn't queue up
          // a stack of identical toasts.
          if (Date.now() - lastBlockedToastRef.current > 3000) {
            useUIStore.getState().addToast(`Blocked: output is ${d.output || 'protected'}`)
            lastBlockedToastRef.current = Date.now()
          }
          return
        }
        if (typeof d.volume === 'number') {
          window.dispatchEvent(new CustomEvent('mac-volume', { detail: { volume: d.volume } }))
        }
      }).catch(() => {})
    })
    return () => {
      Promise.resolve(handle).then(h => h?.remove?.()).catch(() => {})
    }
  }, [])
}
