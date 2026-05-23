import Link from 'next/link';
import { DocumentsList } from '../../../../components/documents-list';

export default async function MaterialsTab({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Materials</h1>
        <p className="text-sm text-muted-foreground">
          Documents indexed under workspace <code className="rounded bg-muted px-1 text-xs">{id}</code>.
        </p>
      </header>

      <DocumentsList
        limit={50}
        emptyHint="No materials yet. Drop a PDF on the Upload page; it lands here automatically."
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
