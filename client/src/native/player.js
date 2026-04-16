// Thin JS wrapper around the native iOS player plugin + system integrations.
//
// When running inside the Capacitor shell (iOS app), these call native APIs
// directly — giving us real Picture-in-Picture, lock-screen controls, AirPlay,
// background audio, haptics, and keep-awake.
//
// On non-native platforms (browser, PWA) every method is a no-op so callers
// don't have to branch.

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
  async setNowPlaying(info) { if (plugin) return plugin.setNowPlaying(info) },
  async clearNowPlaying() { if (plugin) return plugin.clearNowPlaying() },
  async showAirPlayPicker() { if (plugin) return plugin.showAirPlayPicker() },
  async setKeepAwake(enabled) { if (plugin) return plugin.setKeepAwake({ enabled }) },
  addListener(event, handler) {
    if (!plugin) return { remove: () => {} }
    return plugin.addListener(event, handler)
  },
}

// Haptics: real taptic engine on native, silent on web
export async function haptic(style = 'light') {
  if (!isNativeIOS) return
  try {
    const h = cap?.Plugins?.Haptics
    if (!h) return
    await h.impact({ style: style.toUpperCase() }) // 'LIGHT' | 'MEDIUM' | 'HEAVY'
  } catch {}
}
export async function hapticSelection() {
  if (!isNativeIOS) return
  try { await cap.Plugins.Haptics.selectionStart(); await cap.Plugins.Haptics.selectionChanged(); await cap.Plugins.Haptics.selectionEnd() } catch {}
}

// Status bar: dark theme matching --bg
export async function setStatusBarDark() {
  if (!isNativeIOS) return
  try {
    await cap.Plugins.StatusBar.setStyle({ style: 'DARK' })
    await cap.Plugins.StatusBar.setBackgroundColor({ color: '#212121' })
    await cap.Plugins.StatusBar.setOverlaysWebView({ overlay: false })
  } catch {}
}

// Splash screen
export async function hideSplash() {
  if (!isNativeIOS) return
  try { await cap.Plugins.SplashScreen.hide() } catch {}
}

// Share — used by the native share extension (Safari → "YouTubeCtrl")
export async function share({ title, text, url }) {
  if (!isNativeIOS) return
  try { await cap.Plugins.Share.share({ title, text, url }) } catch {}
}
