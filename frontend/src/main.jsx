import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { ScreenShield } from './components/ScreenShield.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <ScreenShield>
        <App />
      </ScreenShield>
    </BrowserRouter>
  </StrictMode>,
)

// Installable app / offline app shell (production builds only, so the
// dev server's hot reload is never served from a stale cache).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
