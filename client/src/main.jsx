import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { loadSavedFont, loadSavedFontSize } from './fonts.js'
import { setStatusBarDark, hideSplash } from './native/player.js'

loadSavedFont()
loadSavedFontSize()

// Native shell boot — no-ops on web
setStatusBarDark()
// Hide splash shortly after first paint
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => setTimeout(hideSplash, 300))
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
