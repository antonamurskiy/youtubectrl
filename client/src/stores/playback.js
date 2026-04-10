import { create } from 'zustand'

export const usePlaybackStore = create((set) => ({
  playing: false,
  url: '',
  position: 0,
  duration: 0,
  paused: false,
  isLive: false,
  player: null, // 'mpv' | 'vlc'
  vlcTime: null,
  absoluteMs: null,
  dvrWindow: 0,
  title: '',
  channel: '',
  thumbnail: '',
  windowMode: null,
  monitor: 'lg',
  serverTs: 0,

  update: (state) => set(state),
  reset: () => set({
    playing: false, url: '', position: 0, duration: 0, paused: false,
    isLive: false, player: null, vlcTime: null, absoluteMs: null,
    dvrWindow: 0, title: '', channel: '', windowMode: null,
  }),
}))
