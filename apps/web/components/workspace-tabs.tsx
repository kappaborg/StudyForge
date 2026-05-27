'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Course workspace tab bar. Client-side so it can highlight the active
 * route via ``usePathname``. ``overflow-x-auto`` lets the row scroll on
 * narrow viewports without forcing a stacked menu drawer.
 */
export function WorkspaceTabs({ courseId }: { courseId: string }) {
  const pathname = usePathname() ?? '';
  const base = `/courses/${courseId}`;
  const tabs: Array<{ href: string; label: string }> = [
    { href: base, label: 'Materials' },
    { href: `${base}/roadmap`, label: 'Roadmap' },
    { href: `${base}/tutor`, label: 'Tutor' },
    { href: `${base}/flashcards`, label: 'Flashcards' },
    { href: `${base}/quizzes`, label: 'Quizzes' },
    { href: `${base}/graph`, label: 'Graph' },
    { href: `${base}/diagrams`, label: 'Diagrams' },
    { href: `${base}/presentations`, label: 'Slides' },
    { href: `${base}/analytics`, label: 'Analytics' },
  ];

  return (
    <nav
      aria-label="Workspace tabs"
      className="mb-6 -mx-3 overflow-x-auto border-b border-border px-3 sm:mx-0 sm:px-0"
    >
      <ul className="flex gap-4 text-sm">
        {tabs.map((t) => {
          const active =
            t.href === base ? pathname === base : pathname.startsWith(t.href);
          return (
            <li key={t.href} className="flex-shrink-0">
              <Link
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={`-mb-px block whitespace-nowrap border-b-2 pb-2 ${
                  active
                    ? 'border-foreground font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
