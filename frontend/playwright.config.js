import { defineConfig, devices } from '@playwright/test';
import { BACKEND_PORT, FRONTEND_PORT } from './e2e/config.js';

// PatientChain e2e suite. Runs against LEDGER_MODE=simulated (no Docker/
// Fabric needed) -- the same demo-mode backend the README recommends for
// day-to-day development. Both servers are started fresh on dedicated
// ports for this run, so they never collide with a developer's own
// `npm start` / `npm run dev` session.
//
// Several pieces of backend state are process-global rather than
// per-patient (the offline-connectivity toggle, the break-glass review
// queue, the cost-model counters), so tests that touch them would race
// each other under parallel workers. Rather than special-case those
// tests, the whole suite runs as a single serial worker -- simple to
// reason about, and fast enough for a suite this size.

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'node src/server.js',
      cwd: '../backend',
      port: BACKEND_PORT,
      env: { PORT: String(BACKEND_PORT), LEDGER_MODE: 'simulated' },
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `npx vite --port ${FRONTEND_PORT} --strictPort`,
      cwd: '.',
      port: FRONTEND_PORT,
      env: { VITE_API_BASE: `http://127.0.0.1:${BACKEND_PORT}/api` },
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
