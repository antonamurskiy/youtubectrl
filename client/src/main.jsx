import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Hls from 'hls.js'
import App from './App.jsx'

// Ensure hls.js is bundled (tree-shaking removes it otherwise)
window.Hls = Hls

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
