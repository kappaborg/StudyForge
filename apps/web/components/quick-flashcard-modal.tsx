'use client';

import { useEffect, useState } from 'react';
import { saveManualFlashcard } from '../lib/flashcards-client';
import { useToast } from './toast';

interface Props {
  selection: string;
  folderId: string | null;
  onClose: () => void;
}

/**
 * One-shot "save this as a flashcard" modal. Pre-fills the back with the
 * highlighted text and seeds the front with a generic prompt — students
 * usually tweak the front into a question form before saving. After save,
 * surfaces a link to the review queue so the card can be exercised right
 * away if they want to lock it in.
 */
export function QuickFlashcardModal({ selection, folderId, onClose }: Props) {
  const toast = useToast();
  const initial = selection.length > 1900 ? selection.slice(0, 1900) + '…' : selection;
  const [front, setFront] = useState('What is this?');
  const [back, setBack] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBack(initial);
    setFront('What is this?');
    setError(null);
  }, [initial]);

  const save = async () => {
    if (!front.trim() || !back.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveManualFlashcard({ front, back, folderId });
      toast.success('Flashcard saved · due now', {
        action: { label: 'Review now', href: '/review' },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-selection-ignore
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-20"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-xl">
        <header className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold">Save as flashcard</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Goes to your "Saved cards" deck. Due for review immediately.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </header>

        <label className="block text-xs">
          <span className="text-muted-foreground">Front (question)</span>
          <input
            value={front}
            onChange={(e) => setFront(e.target.value)}
            disabled={busy}
            className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="mt-3 block text-xs">
          <span className="text-muted-foreground">Back (answer)</span>
          <textarea
            value={back}
            onChange={(e) => setBack(e.target.value)}
            disabled={busy}
            rows={5}
            className="mt-1 block w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </label>

        {error && (
          <p className="mt-3 rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !front.trim() || !back.trim()}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
