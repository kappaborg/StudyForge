'use client';

import { useEffect, useState } from 'react';

interface AxeNode {
  html: string;
  target: string[];
  failureSummary?: string;
}

interface AxeViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  description: string;
  help: string;
  helpUrl: string;
  nodes: AxeNode[];
}

/**
 * Dev-only axe-core runner. Enabled with ``NEXT_PUBLIC_AXE_DEV=1``.
 * Re-audits on route change (URL hash + popstate) and renders a fixed
 * pill that's green when clean, red with a violation count otherwise.
 * Click the pill to dump the violations to the console.
 *
 * This is the lightweight Phase-4 accessibility surface. CI-gated
 * Playwright + axe runs against a fixed set of routes lands in Phase 5.
 */
export function AxeReporter() {
  const enabled =
    process.env.NODE_ENV !== 'production' &&
    process.env['NEXT_PUBLIC_AXE_DEV'] === '1';

  const [count, setCount] = useState<number | null>(null);
  const [violations, setViolations] = useState<AxeViolation[]>([]);

  useEffect(() => {
    if (!enabled) return;

    const audit = async () => {
      try {
        const axe = await import('axe-core');
        const result = await axe.default.run(document, {
          rules: {
            'color-contrast': { enabled: true },
          },
        });
        const v = result.violations as unknown as AxeViolation[];
        setViolations(v);
        setCount(v.length);
      } catch {
        // axe failed — non-fatal for dev tooling.
      }
    };

    // Debounce the auditor so it doesn't run on every render.
    let handle = window.setTimeout(audit, 800);
    const reaudit = () => {
      window.clearTimeout(handle);
      handle = window.setTimeout(audit, 800);
    };
    window.addEventListener('popstate', reaudit);
    return () => {
      window.clearTimeout(handle);
      window.removeEventListener('popstate', reaudit);
    };
  }, [enabled]);

  if (!enabled || count === null) return null;

  const ok = count === 0;
  return (
    <button
      type="button"
      onClick={() => {
        // eslint-disable-next-line no-console
        console.group('[axe] violations');
        for (const v of violations) {
          // eslint-disable-next-line no-console
          console.log(
            `[${v.impact}] ${v.id} — ${v.help}\n  ${v.helpUrl}\n  nodes:`,
            v.nodes.map((n) => n.target.join(' > ')),
          );
        }
        // eslint-disable-next-line no-console
        console.groupEnd();
      }}
      className={`fixed bottom-4 right-4 z-50 rounded-full px-3 py-1 text-xs font-medium shadow-lg ${
        ok
          ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
          : 'border border-rose-500/30 bg-rose-500/10 text-rose-700'
      }`}
      aria-label={ok ? 'axe-core: no a11y violations' : `axe-core: ${count} violations`}
    >
      a11y {ok ? '✓ 0' : `· ${count}`}
    </button>
  );
}
