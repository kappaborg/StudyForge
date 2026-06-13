'use client';

import { useEffect, useState } from 'react';
import { apiGet, ApiError } from '../lib/dev-fetch';

interface FlashcardDiffItem {
  front: string;
  back: string;
}
interface QuizDiffItem {
  prompt: string;
}
interface RoadmapDiffItem {
  weekIndex: number;
  title: string;
}

interface DiffSection<T> {
  added: T[];
  removed: T[];
  unchanged: number;
  hasPrior: boolean;
}

interface DiffPayload {
  courseId: string;
  flashcards: DiffSection<FlashcardDiffItem>;
  quizzes: DiffSection<QuizDiffItem>;
  roadmaps: DiffSection<RoadmapDiffItem>;
}

function SectionHeader({
  title,
  diff,
}: {
  title: string;
  diff: { added: unknown[]; removed: unknown[]; unchanged: number; hasPrior: boolean };
}) {
  if (!diff.hasPrior) {
    return (
      <div className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{title}</span> — no prior version yet
      </div>
    );
  }
  return (
    <div className="flex items-baseline justify-between text-xs">
      <span className="text-sm font-medium">{title}</span>
      <span className="text-muted-foreground">
        <span className="text-emerald-600">+{diff.added.length}</span> ·{' '}
        <span className="text-rose-600">−{diff.removed.length}</span> ·{' '}
        <span>{diff.unchanged} unchanged</span>
      </span>
    </div>
  );
}

export function DiffPanel({ courseId }: { courseId: string }) {
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<DiffPayload>(`/v1/courses/${courseId}/diff`);
      setDiff(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load diff');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  if (loading && !diff) return <p className="text-xs text-muted-foreground">Loading diff…</p>;
  if (error) return <p className="text-xs text-red-500">{error}</p>;
  if (!diff) return null;

  const anyChange =
    diff.flashcards.hasPrior || diff.quizzes.hasPrior || diff.roadmaps.hasPrior;

  return (
    <section className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-semibold">What changed</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Compares the latest generation against the previous one for each artifact kind.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
        >
          Refresh
        </button>
      </header>

      {!anyChange && (
        <p className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
          No prior versions yet. Re-generate an artifact to see a diff here.
        </p>
      )}

      <article className="rounded-lg border border-border p-4 space-y-2">
        <SectionHeader title="Flashcards" diff={diff.flashcards} />
        {diff.flashcards.hasPrior && (
          <DiffList
            added={diff.flashcards.added.map((c) => c.front)}
            removed={diff.flashcards.removed.map((c) => c.front)}
          />
        )}
      </article>

      <article className="rounded-lg border border-border p-4 space-y-2">
        <SectionHeader title="Quizzes" diff={diff.quizzes} />
        {diff.quizzes.hasPrior && (
          <DiffList
            added={diff.quizzes.added.map((q) => q.prompt)}
            removed={diff.quizzes.removed.map((q) => q.prompt)}
          />
        )}
      </article>

      <article className="rounded-lg border border-border p-4 space-y-2">
        <SectionHeader title="Roadmap" diff={diff.roadmaps} />
        {diff.roadmaps.hasPrior && (
          <DiffList
            added={diff.roadmaps.added.map((m) => `W${m.weekIndex} · ${m.title}`)}
            removed={diff.roadmaps.removed.map((m) => `W${m.weekIndex} · ${m.title}`)}
          />
        )}
      </article>
    </section>
  );
}

function DiffList({ added, removed }: { added: string[]; removed: string[] }) {
  if (added.length === 0 && removed.length === 0) {
    return <p className="text-xs text-muted-foreground">No content changes.</p>;
  }
  return (
    <ul className="space-y-1 text-xs">
      {added.map((line, i) => (
        <li key={`a-${i}`} className="rounded-sm bg-emerald-500/10 px-2 py-1">
          <span className="font-mono text-emerald-700">+</span> {line}
        </li>
      ))}
      {removed.map((line, i) => (
        <li key={`r-${i}`} className="rounded-sm bg-rose-500/10 px-2 py-1">
          <span className="font-mono text-rose-700">−</span> {line}
        </li>
      ))}
    </ul>
  );
}
