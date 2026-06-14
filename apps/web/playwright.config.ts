import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for StudyForge web. e2e + axe-core a11y gate.
 *
 * The CI job starts the dev stack (`make up && make dev` in the worker)
 * and then runs this. Locally, you can either:
 *
 *   1. Have `pnpm dev` running and use `--reuse-existing-server`
 *   2. Let Playwright spin up `pnpm dev` itself (slower cold start)
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  timeout: 30_000,
  use: {
    baseURL: process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    extraHTTPHeaders: {
      // The web app reads dev auth from cookies set by an upstream
      // session; the e2e tests target authenticated routes directly
      // through the dev-auth headers passed to the API. The web pages
      // themselves don't need auth headers — they call the API client-
      // side, which adds the headers.
    },
  },
  // Two projects so ``production-smoke.spec.ts`` (hits live Vercel +
  // Render) is opt-in only:
  //   - ``chromium``   default; matches everything EXCEPT production-
  //                    smoke. This is what the standard CI job runs
  //                    against a localhost server.
  //   - ``production`` matches only the production-smoke spec. The
  //                    prod-smoke.yml workflow runs it explicitly via
  //                    ``playwright test --project=production``.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/production-smoke.spec.ts'],
    },
    {
      name: 'production',
      use: { ...devices['Desktop Chrome'] },
      testMatch: ['**/production-smoke.spec.ts'],
    },
  ],
  webServer: process.env['PLAYWRIGHT_BASE_URL']
    ? undefined
    : {
        command: 'pnpm dev',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env['CI'],
        timeout: 60_000,
        cwd: '../../',
      },
});
