import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * a11y gate. axe-core 2.2 AA rules against the route set the project
 * commits to keeping accessible. Violations array must be empty.
 *
 * We disable ``color-contrast`` in headless runs because chromium's
 * background-rendering differs from a real display and produces false
 * positives. Manual audits using the dev-only ``AxeReporter`` cover that
 * locally; CI focuses on structural violations (missing labels, ARIA,
 * focus order, name-role-value).
 */

const ROUTES = [
  { path: '/', name: 'marketing landing' },
  { path: '/dashboard', name: 'dashboard' },
  { path: '/review', name: 'SRS review session' },
  { path: '/mastery', name: 'mastery overview' },
  { path: '/courses/demo', name: 'course workspace · materials' },
  { path: '/courses/demo/flashcards', name: 'workspace · flashcards' },
  { path: '/courses/demo/quizzes', name: 'workspace · quizzes' },
  { path: '/courses/demo/roadmap', name: 'workspace · roadmap' },
  { path: '/courses/demo/graph', name: 'workspace · graph' },
  { path: '/courses/demo/analytics', name: 'workspace · analytics' },
  { path: '/settings/byok', name: 'settings · BYOK + local AI' },
  { path: '/instructor', name: 'instructor portal' },
  { path: '/about', name: 'about (free positioning)' },
];

for (const route of ROUTES) {
  test(`a11y · ${route.name}`, async ({ page }) => {
    await page.goto(route.path);
    // Wait for the page to settle — the dashboard mounts the budget pill
    // asynchronously, and the workspace tabs load data on mount. Without
    // a brief wait the axe scan races against React hydration.
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .disableRules(['color-contrast'])
      .analyze();
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });
}

/**
 * RTL parity. Phase 4 (i18n) introduced ``<html dir="rtl">`` for the
 * ``ar`` locale; verify the bidirectional flip didn't regress a11y on
 * the most-visited surfaces. We don't scan every route in RTL — the
 * structural rules (labels, ARIA, name-role-value) don't care about
 * direction, so a representative sample (landing + dashboard) catches
 * the cases that DO break in RTL (icon-flip targets, mirrored carousel
 * focus order).
 */
const RTL_ROUTES = [
  { path: '/', name: 'RTL · marketing landing' },
  { path: '/dashboard', name: 'RTL · dashboard' },
];

for (const route of RTL_ROUTES) {
  test(`a11y · ${route.name}`, async ({ page, context }) => {
    // Set the locale cookie BEFORE the first navigation so SSR picks
    // ``ar`` up on the initial render — otherwise the first paint is
    // LTR and the axe scan never sees the RTL surface. We pass
    // ``domain``/``path`` instead of ``url`` because the page hasn't
    // navigated yet (it sits on ``about:blank``), and Playwright
    // refuses to bind a cookie to a blank-page origin.
    const baseUrl = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000';
    const { hostname } = new URL(baseUrl);
    await context.addCookies([
      {
        name: 'NEXT_LOCALE',
        value: 'ar',
        domain: hostname,
        path: '/',
        sameSite: 'Lax',
      },
    ]);
    await page.goto(route.path);
    await page.waitForLoadState('networkidle');

    // Sanity check the flip actually engaged. If a future regression
    // breaks the cookie wire-up, this assertion catches it before axe
    // runs and silently passes against an LTR render.
    const dir = await page.evaluate(() => document.documentElement.dir);
    expect(dir).toBe('rtl');

    const results = await new AxeBuilder({ page })
      .disableRules(['color-contrast'])
      .analyze();
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });
}

function formatViolations(
  violations: { id: string; help: string; nodes: { target: unknown[] }[] }[],
): string {
  if (violations.length === 0) return '';
  // Show up to 8 offending nodes per violation — the prior limit of 3
  // hid distinct failure modes when one rule fired across the page
  // (e.g. unlabeled buttons in a list). 8 keeps the output scannable
  // without truncating real signal.
  return violations
    .map(
      (v) =>
        `[${v.id}] ${v.help} — ${v.nodes.length} node(s): ${v.nodes
          .slice(0, 8)
          .map((n) => JSON.stringify(n.target))
          .join(', ')}`,
    )
    .join('\n');
}
