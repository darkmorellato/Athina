import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    // TypeScript type checking in development
    // Uncomment below for strict type checking during dev:
    // checker({ typescript: true }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/backend/**', '!**/backend/src/**'],
    },
  },
  resolve: {
    alias: {
      '@': '/src',
      '@shared': '/shared',
    },
  },
  // Testes de componente (Vitest + Testing Library)
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})