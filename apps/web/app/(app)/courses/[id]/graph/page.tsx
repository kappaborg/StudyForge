import { KnowledgeGraph } from '../../../../../components/knowledge-graph';

export default async function GraphTabPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Knowledge graph</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Concepts laid out left-to-right by prerequisite depth. Drag nodes to
          rearrange; pan and zoom to explore.
        </p>
      </div>
      <KnowledgeGraph courseId={id} />
    </section>
  );
}
