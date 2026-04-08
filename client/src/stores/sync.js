import { create } from 'zustand'

export const useSyncStore = create((set) => ({
  drift: 0,
  userOffset: 0,        // manual offset in seconds (user adjustable via +/- buttons)
  clockOffset: 0,       // server-client clock difference (ms)
  connected: false,
  settling: false,
  settleUntil: 0,
  phoneOpen: false,
  terminalOpen: false,

  setDrift: (drift) => set({ drift }),
  nudgeOffset: (delta) => set((s) => ({ userOffset: +(s.userOffset + delta).toFixed(1) })),
  setClockOffset: (clockOffset) => set({ clockOffset }),
  setConnected: (connected) => set({ connected }),
  setSettling: (until) => set({ settling: true, settleUntil: until }),
  clearSettling: () => set({ settling: false, settleUntil: 0 }),
  setPhoneOpen: (open) => set({ phoneOpen: open }),
  setTerminalOpen: (open) => set({ terminalOpen: open }),
  resetSync: () => set({ drift: 0, baseline: null, settling: false, settleUntil: 0 }),
}))
