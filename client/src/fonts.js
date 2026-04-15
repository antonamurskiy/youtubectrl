// Available monospace fonts. Each entry: [label, CSS family, Google Fonts URL param]
export const FONTS = [
  ['JetBrains Mono',  "'JetBrains Mono', monospace",  'JetBrains+Mono:wght@400;500;700'],
  ['IBM Plex Mono',   "'IBM Plex Mono', monospace",   'IBM+Plex+Mono:wght@400;500;700'],
  ['Space Mono',      "'Space Mono', monospace",      'Space+Mono:wght@400;700'],
  ['Geist Mono',      "'Geist Mono', monospace",      'Geist+Mono:wght@400;500;700'],
  ['Commit Mono',     "'Commit Mono', monospace",     'Commit+Mono:wght@400;500;700'],
  ['Martian Mono',    "'Martian Mono', monospace",    'Martian+Mono:wght@400;500;700'],
  ['DM Mono',         "'DM Mono', monospace",         'DM+Mono:wght@400;500'],
  ['Red Hat Mono',    "'Red Hat Mono', monospace",    'Red+Hat+Mono:wght@400;500;700'],
  ['Fira Code',       "'Fira Code', monospace",       'Fira+Code:wght@400;500;700'],
  ['Azeret Mono',     "'Azeret Mono', monospace",     'Azeret+Mono:wght@400;500;700'],
  ['Monaspace Neon',  "'Monaspace Neon', monospace",  'Monaspace+Neon:wght@400;500;700'],
]

const LINK_ID = 'app-font-link'
const STORAGE_KEY = 'uiFont'

function ensureLink(param) {
  let link = document.getElementById(LINK_ID)
  const href = `https://fonts.googleapis.com/css2?family=${param}&display=swap`
  if (!link) {
    link = document.createElement('link')
    link.id = LINK_ID
    link.rel = 'stylesheet'
    document.head.appendChild(link)
  }
  if (link.href !== href) link.href = href
}

export function applyFont(label) {
  const entry = FONTS.find(f => f[0] === label) || FONTS[0]
  ensureLink(entry[2])
  document.documentElement.style.setProperty('--font', entry[1])
  try { localStorage.setItem(STORAGE_KEY, entry[0]) } catch {}
  window.dispatchEvent(new CustomEvent('app-font-change'))
}

export function loadSavedFont() {
  let saved = null
  try { saved = localStorage.getItem(STORAGE_KEY) } catch {}
  applyFont(saved || FONTS[0][0])
}

export function currentFont() {
  try { return localStorage.getItem(STORAGE_KEY) || FONTS[0][0] } catch { return FONTS[0][0] }
}

// Font size (global UI scale). Applied by overriding --font-lg and --font-sm.
export const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16]
const SIZE_KEY = 'uiFontSize'
const DEFAULT_SIZE = 14

export function applyFontSize(px) {
  const n = Number(px) || DEFAULT_SIZE
  document.documentElement.style.setProperty('--font-lg', `${n}px`)
  document.documentElement.style.setProperty('--font-sm', `${n}px`)
  try { localStorage.setItem(SIZE_KEY, String(n)) } catch {}
  window.dispatchEvent(new CustomEvent('app-font-change'))
}

export function loadSavedFontSize() {
  let saved = null
  try { saved = localStorage.getItem(SIZE_KEY) } catch {}
  applyFontSize(saved ? Number(saved) : DEFAULT_SIZE)
}

export function currentFontSize() {
  try {
    const v = localStorage.getItem(SIZE_KEY)
    return v ? Number(v) : DEFAULT_SIZE
  } catch { return DEFAULT_SIZE }
}
