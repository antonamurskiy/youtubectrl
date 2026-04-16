import { useEffect } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
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
      // Leave intercept off when the hook tears down
      NativePlayer.setVolumeIntercept(false).catch(() => {})
    }
  }, [phoneOnlyUrl, playing])

  // Wire incoming volume events
  useEffect(() => {
    if (!isNativeIOS) return
    const handle = NativePlayer.addListener('volumeButton', ({ delta }) => {
      fetch('/api/volume-bump', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta }),
      }).catch(() => {})
    })
    return () => {
      Promise.resolve(handle).then(h => h?.remove?.()).catch(() => {})
    }
  }, [])
}
