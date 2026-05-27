import { WorkspaceTabs } from '../../../../components/workspace-tabs';

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

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_360px]">
      <div>
        <WorkspaceTabs courseId={id} />
        {children}
      </div>
      <aside aria-label="AI tutor" className="rounded-lg border border-border p-4">
        {tutor}
      </aside>
      {modal}
    </div>
  );
}
