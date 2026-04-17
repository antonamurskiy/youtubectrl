import { create } from 'zustand'

export const usePlaybackStore = create((set) => ({
  playing: false,
  url: '',
  position: 0,
  duration: 0,
  paused: false,
  isLive: false,
  dvrActive: false, // true when mpv is on the VOD proxy — full-duration scrubbing available
  player: null, // 'mpv' | null
  speed: 1,
  absoluteMs: null,
  syncOffsetMs: 0,
  title: '',
  channel: '',
  thumbnail: '',
  windowMode: null,
  monitor: 'lg',
  serverTs: 0,

  update: (state) => set(state),
  reset: () => set({
    playing: false, url: '', position: 0, duration: 0, paused: false,
    isLive: false, player: null, absoluteMs: null,
    title: '', channel: '', windowMode: null,
  }),
}))
