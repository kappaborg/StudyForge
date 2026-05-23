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

function formatViolations(violations: { id: string; help: string; nodes: { target: unknown[] }[] }[]): string {
  if (violations.length === 0) return '';
  return violations
    .map(
      (v) =>
        `[${v.id}] ${v.help} — ${v.nodes.length} node(s): ${v.nodes
          .slice(0, 3)
          .map((n) => JSON.stringify(n.target))
          .join(', ')}`,
    )
    .join('\n');
}
