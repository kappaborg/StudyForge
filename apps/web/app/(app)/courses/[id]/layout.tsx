import Link from 'next/link';

/**
 * Course Workspace shell. Two parallel slots:
 *
 *   - `@tutor`: collapsed by default, expands when the URL carries `?tutor=1`.
 *   - `@modal`: empty by default, populated by intercepting routes
 *               (e.g. `(.)upload/page.tsx`) that overlay without unmounting
 *               the workspace.
 *
 * Each slot has its own `loading` / `error` boundaries, so a slow tutor stream
 * does not block the materials list.
 */
export default async function CourseWorkspaceLayout({
  children,
  tutor,
  modal,
  params,
}: {
  children: React.ReactNode;
  tutor: React.ReactNode;
  modal: React.ReactNode;
  // Next.js 15: dynamic route params are a Promise. Awaited once at the top
  // of every layout / page that needs them.
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tabs = [
    { href: `/courses/${id}`, label: 'Materials' },
    { href: `/courses/${id}/roadmap`, label: 'Roadmap' },
    { href: `/courses/${id}/tutor`, label: 'Tutor' },
    { href: `/courses/${id}/flashcards`, label: 'Flashcards' },
    { href: `/courses/${id}/quizzes`, label: 'Quizzes' },
    { href: `/courses/${id}/graph`, label: 'Graph' },
    { href: `/courses/${id}/diagrams`, label: 'Diagrams' },
    { href: `/courses/${id}/presentations`, label: 'Slides' },
    { href: `/courses/${id}/analytics`, label: 'Analytics' },
  ];

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_360px]">
      <div>
        <nav
          className="mb-6 flex gap-4 border-b border-border text-sm"
          aria-label="Workspace tabs"
        >
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="-mb-px border-b-2 border-transparent pb-2 text-muted-foreground hover:text-foreground hover:border-foreground/30"
            >
              {t.label}
            </Link>
          ))}
        </nav>
        {children}
      </div>
      <aside aria-label="AI tutor" className="rounded-lg border border-border p-4">
        {tutor}
      </aside>
      {modal}
    </div>
  );
}
