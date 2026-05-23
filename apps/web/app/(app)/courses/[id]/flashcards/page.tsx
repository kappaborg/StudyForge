import { FlashcardsPanel } from '../../../../../components/flashcards-panel';

export default async function FlashcardsTabPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Flashcards</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Generate a deck from your materials. Each card cites the source chunk.
        </p>
      </div>
      <FlashcardsPanel courseId={id} />
    </section>
  );
}
