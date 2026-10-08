/**
 * Configuração do E2E do painel (Playwright).
 *
 * O painel sobe no Vite (reutiliza o dev server já em execução) e o backend
 * roda em paralelo — o painel carrega contatos/mensagens via Socket.IO.
 *
 * Uso: npm run test:e2e
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
  },
  webServer: {
    command: 'npm run dev:frontend',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
