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
