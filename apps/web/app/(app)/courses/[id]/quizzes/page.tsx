import { QuizzesPanel } from '../../../../../components/quizzes-panel';

export default async function QuizzesTabPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Quizzes</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Multiple-choice questions from your materials with cited rationales.
        </p>
      </div>
      <QuizzesPanel courseId={id} />
    </section>
  );
}
