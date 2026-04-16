// Thin JS wrapper around the native iOS player plugin.
//
// When running inside the Capacitor shell (iOS app), this calls AVPlayer
// directly — which gives us real Picture-in-Picture, lock-screen controls,
// and background audio.
//
// When running in a regular browser or PWA, all methods become no-ops and
// the existing <video>-based PhonePlayer handles playback.

const cap = typeof window !== 'undefined' ? window.Capacitor : null

export const isNativeIOS = !!(cap?.isNativePlatform?.() && cap.getPlatform?.() === 'ios')

const plugin = cap?.Plugins?.NativePlayer

export const NativePlayer = {
  available: !!plugin,
  async load({ url, position = 0, autoplay = true }) {
    if (!plugin) return
    return plugin.load({ url, position, autoplay })
  },
  async play() { if (plugin) return plugin.play() },
  async pause() { if (plugin) return plugin.pause() },
  async stop() { if (plugin) return plugin.stop() },
  async seek(position) { if (plugin) return plugin.seek({ position }) },
  async setRate(rate) { if (plugin) return plugin.setRate({ rate }) },
  async startPip() { if (plugin) return plugin.startPip() },
  async stopPip() { if (plugin) return plugin.stopPip() },
  async getState() { if (plugin) return plugin.getState() },
  addListener(event, handler) {
    if (!plugin) return { remove: () => {} }
    return plugin.addListener(event, handler)
  },
}
