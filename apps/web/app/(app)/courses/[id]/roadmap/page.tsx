import { RoadmapPanel } from '../../../../../components/roadmap-panel';

export default async function RoadmapTabPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Roadmap</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A weekly study plan synthesized from your materials.
        </p>
      </div>
      <RoadmapPanel courseId={id} />
    </section>
  );
}
