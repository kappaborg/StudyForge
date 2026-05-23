'use client';

import { useEffect, useState } from 'react';
import { track } from '../lib/analytics';
import { apiGetCached, apiPost, ApiError } from '../lib/dev-fetch';

interface DeckSummary {
  id: string;
  title: string;
  cardCount: number;
  createdAt: string;
}

interface Flashcard {
  id: string;
  front: string;
  back: string;
  citationCount?: number;
  citations?: Array<{ chunkId: string; page: number | null; slide: number | null }>;
}

interface DeckDetail {
  id: string;
  title: string;
  flashcards: Flashcard[];
}

interface GenerateResponse {
  deckId: string;
  deckTitle: string;
  flashcards: Flashcard[];
}

export function FlashcardsPanel({ courseId }: { courseId: string }) {
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [deckSize, setDeckSize] = useState(8);
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});

  const refreshDecks = async () => {
    try {
      const res = await apiGetCached<{ decks: DeckSummary[] }>(`/v1/courses/${courseId}/flashcards`);
      setDecks(res.decks);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load decks');
    }
  };

  useEffect(() => {
    void refreshDecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  const onGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<GenerateResponse>('/v1/flashcards/generate', {
        courseId,
        query: query.trim() || undefined,
        deckSize,
      });
      setDeck({ id: res.deckId, title: res.deckTitle, flashcards: res.flashcards });
      setFlipped({});
      track('flashcards.generated', {
        courseId,
        deckSize: res.flashcards.length,
        deckId: res.deckId,
      });
      await refreshDecks();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Generation failed');
    } finally {
      setBusy(false);
    }
  };

  const openDeck = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiGetCached<DeckDetail>(`/v1/flashcards/decks/${id}`);
      setDeck(res);
      setFlipped({});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to open deck');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border p-4 space-y-3">
        <h3 className="text-sm font-semibold">Generate a new deck</h3>
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">Topic (optional)</label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="leave empty for broad coverage"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="w-32">
            <label className="text-xs text-muted-foreground">Deck size</label>
            <input
              type="number"
              min={1}
              max={50}
              value={deckSize}
              onChange={(e) => setDeckSize(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={() => void onGenerate()}
            disabled={busy}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </section>

      {decks.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Your decks
          </h3>
          <ul className="divide-y divide-border rounded-md border border-border">
            {decks.map((d) => (
              <li key={d.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <div className="font-medium">{d.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {d.cardCount} cards · {new Date(d.createdAt).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={() => void openDeck(d.id)}
                  className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
                >
                  Open
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {deck && (
        <section className="space-y-3">
          <header className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">{deck.title}</h3>
            <span className="text-xs text-muted-foreground">{deck.flashcards.length} cards</span>
          </header>
          <ul className="grid gap-3 sm:grid-cols-2">
            {deck.flashcards.map((card) => {
              const isFlipped = !!flipped[card.id];
              return (
                <li key={card.id}>
                  <button
                    onClick={() => {
                      setFlipped((prev) => ({ ...prev, [card.id]: !prev[card.id] }));
                      if (deck) track('flashcards.flipped', { deckId: deck.id, flashcardId: card.id });
                    }}
                    className="block w-full rounded-lg border border-border p-4 text-left transition-colors hover:bg-accent"
                  >
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">
                      {isFlipped ? 'Back' : 'Front'}
                    </div>
                    <p className="mt-2 text-sm">{isFlipped ? card.back : card.front}</p>
                    {(card.citationCount ?? card.citations?.length ?? 0) > 0 && (
                      <p className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {card.citationCount ?? card.citations?.length} citation
                        {(card.citationCount ?? card.citations?.length ?? 0) === 1 ? '' : 's'}
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
