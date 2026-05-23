import { DiagramsPanel } from '../../../../../components/diagrams-panel';

export default async function DiagramsTabPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Diagrams</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Mermaid flowcharts, mindmaps, and sequence diagrams from your
          materials. The agent emits DSL; the browser renders it.
        </p>
      </div>
      <DiagramsPanel courseId={id} />
    </section>
  );
}
