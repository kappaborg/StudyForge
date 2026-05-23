'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { API_BASE, DEV_TENANT_ID, DEV_USER_EMAIL, DEV_USER_ID } from '../lib/dev-fetch';
import {
  chapterUnion,
  getExamScope,
  type ExamScopeRow,
  type ScopeEntry,
} from '../lib/exam-scopes-client';

interface ChatTurn {
  q: string;
  a: string;
  citations: Array<{ chunkId: string; docId: string; page: number | null; score: number }>;
}

/**
 * Single-page exam-scope workspace. Top section summarises the scope; the
 * chat body wires the cloud tutor with `chapters` + `mode` set from the
 * active scope entry. Tabs switch between Theory and Problems (or whatever
 * entries the user saved).
 */
export function ExamScopeView({ scopeId }: { scopeId: string }) {
  const [scope, setScope] = useState<ExamScopeRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [pending, setPending] = useState(false);
  const [partial, setPartial] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setScope(await getExamScope(scopeId));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load scope');
      }
    })();
  }, [scopeId]);

  const activeEntry: ScopeEntry | undefined = scope?.scopes[activeIdx];

  const send = useCallback(async () => {
    if (!scope || !activeEntry || !question.trim() || pending) return;
    const q = question.trim();
    setPending(true);
    setPartial('');
    setQuestion('');
    try {
      const chapters = activeEntry.chapters.length > 0
        ? activeEntry.chapters
        : chapterUnion(scope);
      const res = await fetch(`${API_BASE}/v1/chat/tutor/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-tenant-id': DEV_TENANT_ID,
          'x-user-id': DEV_USER_ID,
          'x-user-email': DEV_USER_EMAIL,
        },
        body: JSON.stringify({
          query: q,
          folderId: scope.folderId,
          chapters,
          mode: activeEntry.mode,
        }),
        credentials: 'include',
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      let acc = '';
      let cites: ChatTurn['citations'] = [];
      await consumeSse(res.body, (event, data) => {
        if (event === 'delta') {
          acc += String(data['text'] ?? '');
          setPartial(acc);
        } else if (event === 'citations') {
          const list = (data['citations'] ?? []) as Array<{
            chunkId?: string;
            docId?: string;
            page?: number | null;
            score?: number;
          }>;
          cites = list.map((c) => ({
            chunkId: c.chunkId ?? '',
            docId: c.docId ?? '',
            page: c.page ?? null,
            score: c.score ?? 0,
          }));
        } else if (event === 'done') {
          const finalText = data['text'];
          if (typeof finalText === 'string' && finalText.length > 0) acc = finalText;
        }
      });
      setHistory((prev) => [...prev, { q, a: acc, citations: cites }]);
      setPartial('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setPending(false);
    }
  }, [scope, activeEntry, question, pending]);

  if (error && !scope) {
    return <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>;
  }
  if (!scope || !activeEntry) {
    return <p className="text-sm text-muted-foreground">Loading scope…</p>;
  }

  const allChapters = chapterUnion(scope);

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{scope.title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Folder:{' '}
            <Link href={`/folders/${scope.folderId}`} className="underline">
              {scope.folderName}
            </Link>{' '}
            · Chapters {allChapters.join(', ') || '—'}
            {scope.examDate && (
              <> · Exam {new Date(scope.examDate).toLocaleDateString()}</>
            )}
          </p>
        </div>
      </header>

      <nav className="flex flex-wrap gap-2 border-b border-border pb-2">
        {scope.scopes.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setActiveIdx(i)}
            className={`rounded-md px-3 py-1.5 text-xs ${
              i === activeIdx
                ? 'bg-foreground text-background'
                : 'border border-border hover:bg-accent'
            }`}
          >
            {s.mode === 'problems' ? 'Problems' : 'Theory'} · Ch{' '}
            {s.chapters.join(', ') || '—'}
          </button>
        ))}
      </nav>

      <div className="space-y-4 rounded-lg border border-border p-4">
        <p className="text-xs text-muted-foreground">
          Asking in <span className="font-medium text-foreground">{activeEntry.mode}</span>{' '}
          mode, scoped to chapters{' '}
          {activeEntry.chapters.length > 0
            ? activeEntry.chapters.join(', ')
            : '(all)'}.
        </p>

        {history.length > 0 && (
          <div className="space-y-3">
            {history.map((t, i) => (
              <article key={i} className="space-y-2">
                <div className="rounded-md bg-foreground px-4 py-2 text-sm text-background">
                  {t.q}
                </div>
                <div className="rounded-md border border-border bg-accent/30 p-4 text-sm">
                  <p className="whitespace-pre-wrap leading-relaxed">{t.a}</p>
                  {t.citations.length > 0 && (
                    <details className="mt-3 text-xs">
                      <summary className="cursor-pointer text-muted-foreground">
                        {t.citations.length} citation
                        {t.citations.length === 1 ? '' : 's'}
                      </summary>
                      <ul className="mt-2 space-y-1 text-muted-foreground">
                        {t.citations.map((c, j) => (
                          <li key={c.chunkId || j} className="flex gap-2">
                            <span className="font-mono">[{j + 1}]</span>
                            <span>
                              doc{' '}
                              <code className="rounded bg-muted px-1">
                                {c.docId.slice(0, 8)}…
                              </code>
                              {c.page !== null && ` · page ${c.page}`} · score{' '}
                              {c.score.toFixed(3)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}

        {pending && partial && (
          <div className="rounded-md border border-border bg-accent/30 p-4 text-sm">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Answering…
            </p>
            <p className="mt-1 whitespace-pre-wrap leading-relaxed">{partial}</p>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="space-y-2"
        >
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={
              activeEntry.mode === 'problems'
                ? 'Ask a problem-solving question for this chapter…'
                : 'Ask a conceptual question scoped to these chapters…'
            }
            rows={3}
            disabled={pending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            className="block w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/30"
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Answers are cited against your folder materials.</span>
            <button
              type="submit"
              disabled={pending || !question.trim()}
              className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
            >
              {pending ? 'Thinking…' : 'Ask'}
            </button>
          </div>
        </form>

        {error && (
          <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
        )}
      </div>
    </section>
  );
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  handle: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep = buf.indexOf('\n\n');
    while (sep !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let evName = 'message';
      const dataParts: string[] = [];
      for (const ln of frame.split('\n')) {
        if (ln.startsWith('event:')) evName = ln.slice(6).trim();
        else if (ln.startsWith('data:')) dataParts.push(ln.slice(5).trim());
      }
      if (dataParts.length > 0) {
        try {
          handle(evName, JSON.parse(dataParts.join('\n')) as Record<string, unknown>);
        } catch {
          // ignore non-JSON frames
        }
      }
      sep = buf.indexOf('\n\n');
    }
  }
}
