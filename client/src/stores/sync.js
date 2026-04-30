import { create } from 'zustand'

export const useSyncStore = create((set) => ({
  drift: 0,
  userOffset: 0,        // manual offset in seconds (user adjustable via +/- buttons)
  clockOffset: 0,       // server-client clock difference (ms)
  connected: false,
  settling: false,
  settleUntil: 0,
  phoneOpen: false,
  phoneOnlyUrl: null,    // when set, phone plays this URL directly (no mpv)
  terminalOpen: false,
  terminalSendKey: null, // function to send key to terminal pty
  commentsOpen: false,
  toggleComments: () => set((s) => ({ commentsOpen: !s.commentsOpen })),
  // Native iOS PiP active state — set by PipToggleButton listeners.
  pipActive: false,
  setPipActive: (on) => set({ pipActive: !!on }),

  setDrift: (drift) => set({ drift }),
  nudgeOffset: (delta) => set((s) => ({ userOffset: +(s.userOffset + delta).toFixed(1) })),
  setClockOffset: (clockOffset) => set({ clockOffset }),
  setConnected: (connected) => set({ connected }),
  setSettling: (until) => set({ settling: true, settleUntil: until }),
  clearSettling: () => set({ settling: false, settleUntil: 0 }),
  setPhoneOpen: (open) => set(open ? { phoneOpen: true } : { phoneOpen: false, phoneOnlyUrl: null, phoneVideoCtrl: null }),
  setPhoneOnly: (url) => set({ phoneOpen: true, phoneOnlyUrl: url }),
  phoneVideoCtrl: null,  // { play, pause, seek } — set by PhonePlayer in phone-only mode
  setPhoneVideoCtrl: (ctrl) => set({ phoneVideoCtrl: ctrl }),
  silentAudioRef: null,  // ref to useMediaSession's silent audio for phone-only handoff
  setSilentAudioRef: (ref) => set({ silentAudioRef: ref }),
  setTerminalOpen: (open) => set({ terminalOpen: open }),
  setTerminalSendKey: (fn) => set({ terminalSendKey: fn }),
  // "Kill feed" of recent Claude pane lines. Each entry { id, text,
  // ts }. Capped at 12 entries; ClaudeFeed prunes by age.
  claudeFeed: [],
  pushClaudeFeed: (lines) => set((s) => {
    const now = Date.now()
    const fresh = lines.map((text, i) => ({ id: `${now}-${i}-${Math.random().toString(36).slice(2, 6)}`, text, ts: now }))
    const next = [...s.claudeFeed, ...fresh]
    return { claudeFeed: next.slice(-12) }
  }),
  pruneClaudeFeed: () => set((s) => {
    // 3500ms matches the .claude-feed-line animation total.
    const cutoff = Date.now() - 3500
    const kept = s.claudeFeed.filter((l) => l.ts > cutoff)
    return kept.length === s.claudeFeed.length ? {} : { claudeFeed: kept }
  }),
  resetSync: () => set({ drift: 0, baseline: null, settling: false, settleUntil: 0 }),
}))
