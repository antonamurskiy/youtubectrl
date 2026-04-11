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
  setTerminalOpen: (open) => set({ terminalOpen: open }),
  setTerminalSendKey: (fn) => set({ terminalSendKey: fn }),
  resetSync: () => set({ drift: 0, baseline: null, settling: false, settleUntil: 0 }),
}))
