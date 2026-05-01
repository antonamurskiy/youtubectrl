import { create } from 'zustand'

export const usePlaybackStore = create((set) => ({
  playing: false,
  url: '',
  position: 0,
  duration: 0,
  paused: false,
  isLive: false,
  isPostLive: false,
  dvrActive: false, // true when mpv is on the VOD proxy — full-duration scrubbing available
  player: null, // 'mpv' | null
  speed: 1,
  absoluteMs: null,
  // For storyboard preview during DVR scrubs: maps scrubber-space to
  // seconds-from-broadcast-start. broadcastStartMs is the wall-clock
  // when broadcast PTS=0; liveEdgeMs is the current live-edge PDT.
  broadcastStartMs: null,
  liveEdgeMs: null,
  syncOffsetMs: 0,
  title: '',
  channel: '',
  thumbnail: '',
  windowMode: null,
  monitor: 'lg',
  serverTs: 0,
  tmuxWindows: [],
  tmuxColors: {},
  macStatus: null,
  claudeOptions: null,
  // Per-window color overrides used during the rename modal's live
  // preview — read first, then fall back to tmuxColors. Survives the
  // 1Hz WS broadcast that would otherwise overwrite the optimistic
  // tmuxColors update with the server's persisted state.
  tmuxColorPreview: {},

  update: (state) => set(state),
  reset: () => set({
    playing: false, url: '', position: 0, duration: 0, paused: false,
    isLive: false, player: null, absoluteMs: null,
    title: '', channel: '', windowMode: null,
  }),
}))
