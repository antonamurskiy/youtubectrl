import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { loadSavedFont, loadSavedFontSize } from './fonts.js'

loadSavedFont()
loadSavedFontSize()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
