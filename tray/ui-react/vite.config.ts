import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig(({ command }) => ({
  // Tauri installed apps need relative asset paths; dev server still uses root paths.
  base: command === 'serve' ? '/' : './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
  },
}))
