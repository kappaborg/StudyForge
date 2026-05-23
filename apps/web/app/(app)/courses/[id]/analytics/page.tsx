import { DiffPanel } from '../../../../../components/diff-panel';
import { MasteryPanel } from '../../../../../components/mastery-panel';

export default async function AnalyticsTabPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Per-concept mastery driven by the Student Progress agent. Take a
          quiz from the Quizzes tab to update these scores.
        </p>
      </div>
      <MasteryPanel courseId={id} />
      <DiffPanel courseId={id} />
    </section>
  );
}
