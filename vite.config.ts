import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    sourcemap: true,
  },
  server: {
    port: 5008,
    allowedHosts: ["localhost", "127.0.0.1", "dev8.kenarnold.org"],
    hmr: {
      overlay: false,
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        secure: false,
      },
      '/socket': {
        target: 'ws://localhost:8000',
        ws: true
      }
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    // Claude Code worktrees are full checkouts under .claude/, so without this a run from
    // the repo root also collects every test in every worktree and reports their stale
    // copies as failures of this one.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  }
})
