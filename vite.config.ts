import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { orbitPgPlugin } from './server/pgApi.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), orbitPgPlugin()],
})
