import Link from 'next/link';
import { DocumentsList } from '../../../../components/documents-list';

export default async function MaterialsTab({
  params: _params,
}: {
  params: Promise<{ id: string }>;
}) {
  // The id is reserved for future workspace-scoped filtering; today the
  // documents list returns the tenant view and the workspace tab acts as
  // a sectioned entry point. Left underscored so the lint rule passes.
  await _params;
  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Materials</h1>
        <p className="text-sm text-muted-foreground">
          Everything you've uploaded, with the folder it lives in. Click a row
          to jump to that folder.
        </p>
      </header>

      <DocumentsList
        limit={50}
        emptyHint="No materials yet. Drop a file on the Materials page; it lands here automatically."
      />

      <Link
        href="/upload"
        className="inline-block rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
      >
        Upload more materials
      </Link>
    </section>
  );
}
