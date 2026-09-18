import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/space-grotesk'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { bootLab, useLab } from './store'

bootLab()
if (import.meta.env.DEV) Object.assign(window, { lab: useLab })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
