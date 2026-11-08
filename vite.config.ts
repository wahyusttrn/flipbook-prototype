import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    // Runs worker/index.ts alongside the dev server: /api/* goes to the Worker,
    // everything else is the React SPA. Same setup is used for deploy.
    cloudflare(),
  ],
  // Pre-bundle deps that are only imported by lazy admin routes. Otherwise Vite finds
  // them on first visit, re-optimizes, and the lazy chunk import fails once.
  optimizeDeps: {
    include: ['@supabase/supabase-js', 'qrcode', 'fflate'],
  },
})
