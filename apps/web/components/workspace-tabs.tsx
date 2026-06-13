'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

/**
 * Course workspace tab bar. Client-side so it can highlight the active
 * route via ``usePathname``. ``overflow-x-auto`` lets the row scroll on
 * narrow viewports without forcing a stacked menu drawer.
 *
 * Labels come from the ``workspace`` message namespace — the bundles
 * carry these keys for every supported locale, so a non-English user
 * sees translated tabs as soon as they switch the locale picker.
 */
export function WorkspaceTabs({ courseId }: { courseId: string }) {
  const pathname = usePathname() ?? '';
  const tw = useTranslations('workspace');
  const base = `/courses/${courseId}`;
  const tabs: Array<{ href: string; label: string }> = [
    { href: base, label: tw('materials') },
    { href: `${base}/roadmap`, label: tw('roadmap') },
    { href: `${base}/tutor`, label: tw('tutor') },
    { href: `${base}/flashcards`, label: tw('flashcards') },
    { href: `${base}/quizzes`, label: tw('quizzes') },
    { href: `${base}/graph`, label: tw('graph') },
    { href: `${base}/diagrams`, label: tw('diagrams') },
    { href: `${base}/presentations`, label: tw('slides') },
    { href: `${base}/analytics`, label: tw('analytics') },
  ];

  return (
    <nav
      aria-label="Workspace tabs"
      className="mb-6 -mx-3 overflow-x-auto border-b border-border px-3 sm:mx-0 sm:px-0"
    >
      <ul className="flex gap-4 text-sm">
        {tabs.map((tab) => {
          const active =
            tab.href === base
              ? pathname === base
              : pathname.startsWith(tab.href);
          return (
            <li key={tab.href} className="flex-shrink-0">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={`-mb-px block whitespace-nowrap border-b-2 pb-2 ${
                  active
                    ? 'border-foreground font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
