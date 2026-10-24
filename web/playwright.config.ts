/**
 * Playwright config for the closed-loop demo E2E (Req 43; design §20).
 *
 * - One worker, no retries, chromium only. The spec opens its own contexts:
 *   a desktop doctor context and a Pixel 7 ASHA context.
 * - `webServer` starts the backend (seeding first with `--if-empty`, so a fresh
 *   checkout has `doctor1`/`asha1`) and the Vite dev server. Both reuse servers
 *   that are already running, e.g. the ones `start.ps1` opened.
 * - Screenshots go to `docs/screenshots/` (see `e2e/demo-loop.spec.ts`); traces
 *   and reports stay in the git-ignored `test-results/` and `playwright-report/`.
 *
 * Run: `npx playwright install chromium` once, then `npm run e2e`.
 */
import { defineConfig } from '@playwright/test';

// Minimal module-local typing for Node's `process`: the project has no @types/node
// (design §1), and Playwright transpiles this file without type-checking it.
declare const process: { platform: string; env: Record<string, string | undefined> };

const isWindows = process.platform === 'win32';

// Playwright runs webServer commands through the shell. On Windows Node uses
// %ComSpec%; some shells (e.g. agent-launched PowerShell) leave it unset, which
// makes `spawn` fail before `npm` or `&&` ever run.
if (isWindows && !process.env.ComSpec) {
  process.env.ComSpec = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`;
}

// Relative to `cwd: '../backend'`.
const python = isWindows ? '.venv\\Scripts\\python' : '.venv/bin/python';

/** Backend env for a server Playwright starts. A reused server keeps its own env. */
const backendEnv: Record<string, string> = {
  MAATRIVA_DEMO: '1',
  // Fixed, E2E-only secret (never used outside local demo runs); tokens are
  // minted fresh in every run, so it only has to be stable within one run.
  MAATRIVA_JWT_SECRET: 'maatriva-e2e-only-not-a-real-secret-0123456789abcdef',
  PYTHONUNBUFFERED: '1',
};
if (process.env.ComSpec) backendEnv.ComSpec = process.env.ComSpec;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: `${python} -m app.seed --if-empty && ${python} -m uvicorn app.main:app --host 127.0.0.1 --port 8000`,
      cwd: '../backend',
      url: 'http://127.0.0.1:8000/api/health',
      env: backendEnv,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5173',
      env: process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {},
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
