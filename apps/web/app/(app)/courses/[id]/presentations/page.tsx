import { PresentationsPanel } from '../../../../../components/presentations-panel';

export default async function PresentationsTabPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Presentations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A study deck drafted from your materials. Use arrow keys to navigate
          slides; copy the markdown into reveal.js / Slidev to export.
        </p>
      </div>
      <PresentationsPanel courseId={id} />
    </section>
  );
}
