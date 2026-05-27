'use client';

import { useState } from 'react';
import {
  createExamScope,
  parseExamScope,
  type ScopeEntry,
} from '../lib/exam-scopes-client';
import { track } from '../lib/analytics';
import { useToast } from './toast';

interface Props {
  folderId: string;
  folderName: string;
  onClose: () => void;
  onCreated: (scopeId: string) => void;
}

/**
 * Two-step modal: paste → confirm/edit → save.
 *
 *  - Step 1 takes the prof's raw text and ships it to the worker parser.
 *  - Step 2 shows the parsed scopes with editable chapter / topic chips and
 *    a title field. The student can add/remove chapters or whole entries
 *    before persisting.
 *
 * Both steps fit inside the same modal so the student never loses their
 * source text or has to start over after a bad parse.
 */
export function ExamScopeModal({ folderId, folderName, onClose, onCreated }: Props) {
  const toast = useToast();
  const [raw, setRaw] = useState('');
  const [examDate, setExamDate] = useState('');
  const [title, setTitle] = useState('');
  const [scopes, setScopes] = useState<ScopeEntry[]>([]);
  const [parsed, setParsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doParse = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await parseExamScope(raw);
      setTitle(result.title);
      setScopes(result.scopes);
      setParsed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not parse');
    } finally {
      setBusy(false);
    }
  };

  const doSave = async () => {
    setError(null);
    setBusy(true);
    try {
      const created = await createExamScope({
        folderId,
        title: title.trim() || 'Exam scope',
        scopes,
        examDate: examDate || null,
        rawText: raw,
      });
      track('scope.created', {
        scopeId: created.id,
        entryCount: created.scopes.length,
        hasExamDate: Boolean(created.examDate),
      });
      toast.success(`Saved scope "${created.title}"`);
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-xl sm:p-5">
        <header className="mb-3">
          <h3 className="text-base font-semibold">
            {parsed ? 'Confirm exam scope' : 'New exam scope'}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Paste what the professor shared, we'll structure it so the tutor and
            study tools focus on exactly that material — within "{folderName}".
          </p>
        </header>

        {!parsed && (
          <div className="space-y-3">
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={6}
              placeholder={`Theory: Chapter 4 and 6 (Mapping and Microbial Genetics)\nProblems: Chapter 4 (Mapping/Linkage Analysis)`}
              className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            {error && (
              <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
            )}
            <div className="flex justify-end gap-2">
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
                onClick={doParse}
                disabled={busy || !raw.trim()}
                className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Parsing…' : 'Parse'}
              </button>
            </div>
          </div>
        )}

        {parsed && (
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="text-muted-foreground">Title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted-foreground">Exam date (optional)</span>
              <input
                type="date"
                value={examDate}
                onChange={(e) => setExamDate(e.target.value)}
                className="mt-1 block w-48 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </label>

            <div className="space-y-3">
              {scopes.map((s, i) => (
                <ScopeRow
                  key={i}
                  entry={s}
                  onChange={(next) =>
                    setScopes((prev) => prev.map((p, j) => (j === i ? next : p)))
                  }
                  onRemove={() =>
                    setScopes((prev) => prev.filter((_, j) => j !== i))
                  }
                />
              ))}
              <button
                type="button"
                onClick={() =>
                  setScopes((prev) => [
                    ...prev,
                    { mode: 'theory', chapters: [], topics: [] },
                  ])
                }
                className="rounded-md border border-dashed border-border px-3 py-1.5 text-xs hover:bg-accent"
              >
                + Add another scope
              </button>
            </div>

            {error && (
              <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
            )}

            <div className="flex justify-between gap-2">
              <button
                type="button"
                onClick={() => setParsed(false)}
                disabled={busy}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
              >
                ← Back to text
              </button>
              <div className="flex gap-2">
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
                  onClick={doSave}
                  disabled={busy || scopes.length === 0}
                  className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Save scope'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ScopeRow({
  entry,
  onChange,
  onRemove,
}: {
  entry: ScopeEntry;
  onChange: (next: ScopeEntry) => void;
  onRemove: () => void;
}) {
  const [chapText, setChapText] = useState(entry.chapters.join(', '));
  const [topicText, setTopicText] = useState(entry.topics.join(', '));

  const commitChapters = (value: string) => {
    const next = value
      .split(/[,\s]+/)
      .map((t) => parseInt(t, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    const dedup = Array.from(new Set(next)).sort((a, b) => a - b);
    onChange({ ...entry, chapters: dedup });
  };

  const commitTopics = (value: string) => {
    const next = value
      .split(/,\s*/)
      .map((t) => t.trim())
      .filter(Boolean);
    onChange({ ...entry, topics: Array.from(new Set(next)) });
  };

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <select
          value={entry.mode}
          onChange={(e) => onChange({ ...entry, mode: e.target.value as 'theory' | 'problems' })}
          className="rounded border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="theory">Theory</option>
          <option value="problems">Problems</option>
        </select>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove scope row"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>
      <label className="mt-3 block text-xs">
        <span className="text-muted-foreground">Chapters (comma-separated)</span>
        <input
          value={chapText}
          onChange={(e) => setChapText(e.target.value)}
          onBlur={(e) => commitChapters(e.target.value)}
          placeholder="4, 6"
          className="mt-1 block w-full rounded border border-border bg-background px-2 py-1 text-xs"
        />
      </label>
      <label className="mt-2 block text-xs">
        <span className="text-muted-foreground">Topics (comma-separated)</span>
        <input
          value={topicText}
          onChange={(e) => setTopicText(e.target.value)}
          onBlur={(e) => commitTopics(e.target.value)}
          placeholder="Mapping, Microbial Genetics"
          className="mt-1 block w-full rounded border border-border bg-background px-2 py-1 text-xs"
        />
      </label>
    </div>
  );
}
