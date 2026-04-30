import { useEffect } from 'react'
import { isNativeIOS, NativePlayer } from '../native/player'
import { useSyncStore } from '../stores/sync'
import { usePlaybackStore } from '../stores/playback'

// React side of the notification-tap flow:
//   1. Banner tap → switch to source tmux pane + open the terminal
//      panel so the user sees the running session.
//   2. Action button tap (1/2/3/4) → ALSO POST /api/tmux-send with
//      the digit so Claude receives the answer.
// JS does these fetches (rather than Swift's AppDelegate) because
// Swift URLSession requests from inside the system action handler
// race with the OS suspending the handler and routinely don't
// reach the local server. JS has a live network context.
function dbg(msg) {
  try {
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'pushTap', msg }),
    }).catch(() => {})
  } catch {}
}

// Dedupe key: prevents the same answer from being sent twice when
// both `getPendingPushTap` (mount drain) AND the live `pushTap`
// event fire for the same notification — happens routinely when
// the app cold-launches via an action button.
let _lastHandled = ''
async function handleTap({ tmuxWindow, answer }) {
  const key = `${tmuxWindow}:${answer}:${Math.floor(Date.now() / 5000)}`
  if (key === _lastHandled) return
  _lastHandled = key
  dbg(`handleTap tmuxWindow=${tmuxWindow} answer=${JSON.stringify(answer)}`)
  useSyncStore.getState().setTerminalOpen(true)
  if (typeof tmuxWindow === 'number' && tmuxWindow >= 0) {
    const tw = usePlaybackStore.getState().tmuxWindows
    if (Array.isArray(tw) && tw.length > 1) {
      usePlaybackStore.getState().update({
        tmuxWindows: tw.map((w) => ({ ...w, active: w.index === tmuxWindow })),
      })
    }
    try {
      await fetch('/api/tmux-select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: tmuxWindow }),
      })
    } catch {}
  }
  if (answer) {
    await new Promise((r) => setTimeout(r, 120))
    try {
      await fetch('/api/tmux-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: String(answer) }),
      })
    } catch {}
  }
}

export function usePushTap() {
  useEffect(() => {
    if (!isNativeIOS || !NativePlayer.available) return
    // 1. Drain any tap that fired BEFORE this hook subscribed —
    //    typical when the action button cold-launches the app.
    dbg('hook mounted, polling getPendingPushTap')
    NativePlayer.getPendingPushTap().then((data) => {
      dbg(`pending=${JSON.stringify(data)}`)
      if (!data) return
      if (data.debug) dbg(`native debug: ${data.debug}`)
      const tmuxWindow = typeof data.tmuxWindow === 'number' ? data.tmuxWindow : -1
      const answer = data.answer || ''
      if (tmuxWindow < 0 && !answer) return
      handleTap({ tmuxWindow, answer })
    }).catch((e) => dbg(`getPendingPushTap error: ${e?.message}`))
    // 2. Subscribe for live taps while the app is running.
    const sub = NativePlayer.addListener('pushTap', (e) => {
      // Drain the AppDelegate static at the same time so a later
      // hook re-mount (route change, re-render, etc.) doesn't replay
      // the same answer via getPendingPushTap. Without this the
      // digit was getting sent twice on some flows.
      NativePlayer.getPendingPushTap().catch(() => {})
      handleTap({ tmuxWindow: e?.tmuxWindow, answer: e?.answer })
    })
    return () => { try { sub?.remove?.() } catch {} }
  }, [])
}
