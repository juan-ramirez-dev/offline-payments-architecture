import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build works under GitHub Pages (/offline-payments-architecture/).
  base: './',
  server: { port: 5173 },
})
