import { test, expect } from '@playwright/test';

/**
 * Production smoke — runs on a CI cron against the live Vercel + Render
 * deploy. Catches drift BETWEEN our pushes: a Vercel platform update
 * that breaks a route, a Render dyno that won't wake, an API auth
 * boundary that regressed, a footer link that went missing.
 *
 * Auth is out of scope here (no test credentials in CI). The 10-step
 * manual smoke in ``SMOKE_PRODUCTION.md`` still owns the authenticated
 * flows (OAuth, ingest, tutor stream, quiz attempt). This spec is the
 * automated half — every public surface, the API health proxy, the
 * auth boundary's failure shape.
 *
 * Invocation:
 *   PLAYWRIGHT_BASE_URL=https://study-forge-web.vercel.app \
 *     pnpm --filter web e2e production-smoke
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'https://study-forge-web.vercel.app';

test.describe('production smoke · public surfaces', () => {
  test('landing renders with brand + Google sign-in CTA', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/StudyForge/i);
    // Either the marketing landing CTA OR the dashboard (if a tester
    // happens to be signed in via cookie persistence). Both shapes are
    // acceptable "the app is alive."
    const sawSignedOutShell = await page
      .getByRole('link', { name: /sign in|continue with google|get started/i })
      .first()
      .isVisible()
      .catch(() => false);
    const sawSignedInShell = await page
      .getByRole('heading', { name: /dashboard/i })
      .first()
      .isVisible()
      .catch(() => false);
    expect(sawSignedOutShell || sawSignedInShell).toBe(true);
  });

  test('/login renders without throwing', async ({ page }) => {
    const response = await page.goto('/login');
    expect(response?.status()).toBeLessThan(400);
    // App router error boundary renders this h1 when a server component
    // throws. If it's present we'd be looking at a regression.
    await expect(
      page.getByRole('heading', { name: /something went wrong/i }),
    ).toHaveCount(0);
  });

  test('/signup renders without throwing', async ({ page }) => {
    const response = await page.goto('/signup');
    expect(response?.status()).toBeLessThan(400);
  });

  test('/about renders with the "free forever" positioning', async ({ page }) => {
    await page.goto('/about');
    await expect(
      page.getByRole('heading', { name: /free/i }).first(),
    ).toBeVisible();
  });

  test('/privacy renders the Privacy Policy heading', async ({ page }) => {
    await page.goto('/privacy');
    await expect(
      page.getByRole('heading', { name: /privacy policy/i, level: 1 }),
    ).toBeVisible();
    // Each section header guards against the page rendering blank.
    await expect(page.getByRole('heading', { name: /what we collect/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /your rights/i })).toBeVisible();
  });

  test('/terms renders the Terms of Service heading', async ({ page }) => {
    await page.goto('/terms');
    await expect(
      page.getByRole('heading', { name: /terms of service/i, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: /your account/i })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /ai-generated content/i }),
    ).toBeVisible();
  });

  test('footer exposes Privacy + Terms links (app-store gate)', async ({ page }) => {
    await page.goto('/');
    const footer = page.getByRole('contentinfo').or(page.locator('footer'));
    await expect(footer.getByRole('link', { name: /privacy/i })).toBeVisible();
    await expect(footer.getByRole('link', { name: /terms/i })).toBeVisible();
  });
});

test.describe('production smoke · API plumbing', () => {
  test('/manifest.webmanifest is served and parses as JSON', async ({ request }) => {
    const response = await request.get(`${BASE}/manifest.webmanifest`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    // PWA-install gate: Chrome won't offer the install prompt without
    // these fields. Regression here = lost PWA install on next deploy.
    expect(body).toMatchObject({
      name: expect.any(String),
      start_url: expect.any(String),
      display: expect.any(String),
      icons: expect.any(Array),
    });
  });

  test('Vercel rewrite proxies /health to the Render API', async ({ request }) => {
    // Cold-start tolerance: Render free-tier dynos take ~30s to wake.
    // Give the request room without making the whole spec lazy.
    const response = await request.get(`${BASE}/health`, { timeout: 60_000 });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'ok',
      service: 'api',
    });
  });

  test('protected API endpoint returns 401 with Problem+JSON shape', async ({
    request,
  }) => {
    // /v1/auth/me is the canonical "who am I" — no cookie, no answer.
    // The shape matters for the client error handler (it pattern-matches
    // on ``code`` to decide whether to redirect to /login).
    const response = await request.get(`${BASE}/v1/auth/me`, {
      timeout: 60_000,
      // Don't follow redirects; we want to see the API's actual response.
      maxRedirects: 0,
    });
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 401,
      code: 'auth.unauthenticated',
    });
  });
});
