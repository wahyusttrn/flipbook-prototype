import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { devApi } from './server/devApi.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    // /api/* in dev → server/app.ts (in production: Vercel function api/index.ts)
    devApi(),
  ],
  // Pre-bundle deps that are only imported by lazy admin routes. Otherwise Vite finds
  // them on first visit, re-optimizes, and the lazy chunk import fails once.
  optimizeDeps: {
    include: ['@supabase/supabase-js', 'qrcode', 'fflate', 'mediabunny', 'pdf-lib', 'gifenc'],
  },
})
