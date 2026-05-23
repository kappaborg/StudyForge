'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  chapterUnion,
  deleteExamScope,
  listExamScopes,
  type ExamScopeRow,
} from '../lib/exam-scopes-client';

export function ExamScopesGrid() {
  const [scopes, setScopes] = useState<ExamScopeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setScopes(await listExamScopes());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load exam scopes');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (s: ExamScopeRow) => {
    if (!confirm(`Delete exam scope "${s.title}"?`)) return;
    try {
      await deleteExamScope(s.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  if (scopes === null) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
        Loading exam scopes…
      </div>
    );
  }

  if (error) {
    return (
      <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
    );
  }

  if (scopes.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
        No exam scopes yet. Open a folder and use "Set exam scope" — paste the
        professor's message and we'll structure it for focused study.
      </p>
    );
  }

  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {scopes.map((s) => (
        <ScopeCard key={s.id} scope={s} onDelete={() => void remove(s)} />
      ))}
    </ul>
  );
}

function ScopeCard({
  scope,
  onDelete,
}: {
  scope: ExamScopeRow;
  onDelete: () => void;
}) {
  const chapters = chapterUnion(scope);
  const dueSoon = scope.examDate ? daysUntil(scope.examDate) : null;
  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{scope.title}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            Folder: {scope.folderName}
          </p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete scope"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          ✕
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {scope.scopes.map((s, i) => (
          <span
            key={i}
            className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wider ${
              s.mode === 'problems'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-sky-100 text-sky-800'
            }`}
          >
            {s.mode} · Ch {s.chapters.join(', ') || '—'}
          </span>
        ))}
      </div>
      {scope.scopes.some((s) => s.topics.length > 0) && (
        <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
          Topics:{' '}
          {Array.from(new Set(scope.scopes.flatMap((s) => s.topics))).join(', ')}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          {chapters.length} chapter{chapters.length === 1 ? '' : 's'} ·{' '}
          {scope.examDate
            ? `${new Date(scope.examDate).toLocaleDateString()}${
                dueSoon !== null
                  ? dueSoon <= 0
                    ? ' · past'
                    : dueSoon <= 7
                      ? ` · in ${dueSoon}d`
                      : ''
                  : ''
              }`
            : 'no date set'}
        </p>
        <Link
          href={`/exam-scopes/${scope.id}`}
          className="rounded-md bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90"
        >
          Open
        </Link>
      </div>
    </li>
  );
}

function daysUntil(iso: string): number {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return days;
}
