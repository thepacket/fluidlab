import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/space-grotesk'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import './analytics.css'
import { initAnalytics } from './analytics'
import { bootLab, useLab } from './store'

bootLab()
initAnalytics()
if (import.meta.env.DEV) Object.assign(window, { lab: useLab })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
