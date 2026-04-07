import { create } from 'zustand'

export const useSyncStore = create((set) => ({
  drift: 0,
  baseline: null,       // initial PDT offset captured on first stable measurement
  clockOffset: 0,       // server-client clock difference (ms)
  connected: false,
  settling: false,
  settleUntil: 0,
  phoneOpen: false,

  setDrift: (drift) => set({ drift }),
  setBaseline: (baseline) => set({ baseline }),
  setClockOffset: (clockOffset) => set({ clockOffset }),
  setConnected: (connected) => set({ connected }),
  setSettling: (until) => set({ settling: true, settleUntil: until }),
  clearSettling: () => set({ settling: false, settleUntil: 0 }),
  setPhoneOpen: (open) => set({ phoneOpen: open }),
  resetSync: () => set({ drift: 0, baseline: null, settling: false, settleUntil: 0 }),
}))
