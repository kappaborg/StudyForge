'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiPost, ApiError } from '../lib/dev-fetch';

interface PresentationDto {
  courseId: string;
  title: string;
  markdown: string;
  slideCount: number;
}

function splitSlides(markdown: string): string[] {
  return markdown
    .split(/\n---\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function renderSlide(md: string): React.ReactNode {
  const lines = md.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('# ')) {
      out.push(
        <h2 key={key++} className="text-3xl font-semibold tracking-tight">
          {line.slice(2)}
        </h2>,
      );
      i++;
    } else if (line.startsWith('## ')) {
      out.push(
        <h3 key={key++} className="text-2xl font-semibold">
          {line.slice(3)}
        </h3>,
      );
      i++;
    } else if (line.startsWith('- ')) {
      const bullets: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('- ')) {
        bullets.push(lines[i]!.slice(2));
        i++;
      }
      out.push(
        <ul key={key++} className="space-y-2 text-base">
          {bullets.map((b, j) => (
            <li key={j} className="list-disc ml-6">
              {b}
            </li>
          ))}
        </ul>,
      );
    } else if (line.trim().length > 0) {
      out.push(
        <p key={key++} className="text-base text-muted-foreground">
          {line}
        </p>,
      );
      i++;
    } else {
      i++;
    }
  }
  return out;
}

export function PresentationsPanel({ courseId }: { courseId: string }) {
  const [deck, setDeck] = useState<PresentationDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [slideCount, setSlideCount] = useState(8);
  const [active, setActive] = useState(0);
  const [showSource, setShowSource] = useState(false);

  const slides = useMemo(() => (deck ? splitSlides(deck.markdown) : []), [deck]);

  // Arrow keys navigate when a deck is shown.
  useEffect(() => {
    if (!deck) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setActive((i) => Math.min(i + 1, slides.length - 1));
      else if (e.key === 'ArrowLeft') setActive((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deck, slides.length]);

  const onGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<PresentationDto>('/v1/presentations/generate', {
        courseId,
        query: query.trim() || undefined,
        slideCount,
      });
      setDeck(res);
      setActive(0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Generation failed');
    } finally {
      setBusy(false);
    }
  };

  const copyMarkdown = async () => {
    if (!deck) return;
    try {
      await navigator.clipboard.writeText(deck.markdown);
    } catch {
      // Ignore; older browsers without clipboard API.
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border p-4 space-y-3">
        <h3 className="text-sm font-semibold">Generate a presentation</h3>
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">Focus (optional)</label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="leave empty for end-to-end coverage"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="w-24">
            <label className="text-xs text-muted-foreground">Slides</label>
            <input
              type="number"
              min={4}
              max={20}
              value={slideCount}
              onChange={(e) =>
                setSlideCount(Math.max(4, Math.min(20, Number(e.target.value) || 4)))
              }
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={() => void onGenerate()}
            disabled={busy}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Drafting…' : 'Generate'}
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </section>

      {deck && (
        <section className="space-y-3">
          <header className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">{deck.title}</h3>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                {active + 1} / {slides.length}
              </span>
              <button
                onClick={() => void copyMarkdown()}
                className="rounded-md border border-border px-2 py-1 hover:bg-accent"
              >
                Copy markdown
              </button>
              <button
                onClick={() => setShowSource((s) => !s)}
                className="hover:text-foreground"
              >
                {showSource ? 'Hide source' : 'View source'}
              </button>
            </div>
          </header>

          <div className="rounded-lg border border-border bg-card p-10 min-h-[420px] space-y-4">
            {slides[active] ? renderSlide(slides[active]) : <p>(empty slide)</p>}
          </div>

          <div className="flex justify-between text-xs">
            <button
              onClick={() => setActive((i) => Math.max(0, i - 1))}
              disabled={active === 0}
              className="rounded-md border border-border px-3 py-1 hover:bg-accent disabled:opacity-40"
            >
              ← Previous
            </button>
            <span className="text-muted-foreground">↑ Arrow keys navigate</span>
            <button
              onClick={() => setActive((i) => Math.min(slides.length - 1, i + 1))}
              disabled={active === slides.length - 1}
              className="rounded-md border border-border px-3 py-1 hover:bg-accent disabled:opacity-40"
            >
              Next →
            </button>
          </div>

          {showSource && (
            <pre className="overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
              <code>{deck.markdown}</code>
            </pre>
          )}
        </section>
      )}
    </div>
  );
}
