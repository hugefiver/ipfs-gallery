import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== '1') {
  void import('react-grab')
  void import('react-scan').then(({ scan }) => scan({ enabled: true }))
}

const root = document.getElementById('root')
if (!root) throw new Error('Application mount is missing')
createRoot(root).render(<StrictMode><App /></StrictMode>)
