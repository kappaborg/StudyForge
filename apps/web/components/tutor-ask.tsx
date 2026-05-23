'use client';

import * as React from 'react';
import { track } from '../lib/analytics';
import {
  API_BASE,
  ApiError,
  DEV_TENANT_ID,
  DEV_USER_EMAIL,
  DEV_USER_ID,
} from '../lib/dev-fetch';

interface Citation {
  chunkId: string;
  docId: string;
  page: number | null;
  score: number;
}

type SseHandler = (event: string, data: Record<string, unknown>) => void;

async function consumeSSE(body: ReadableStream<Uint8Array>, handle: SseHandler) {
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
      const lines = frame.split('\n');
      let evName = 'message';
      const dataParts: string[] = [];
      for (const ln of lines) {
        if (ln.startsWith('event:')) evName = ln.slice(6).trim();
        else if (ln.startsWith('data:')) dataParts.push(ln.slice(5).trim());
      }
      if (dataParts.length > 0) {
        try {
          handle(evName, JSON.parse(dataParts.join('\n')) as Record<string, unknown>);
        } catch {
          // Bad JSON frame — skip.
        }
      }
      sep = buf.indexOf('\n\n');
    }
  }
}

interface AskResponse {
  refusal: boolean;
  text: string;
  citations: Citation[];
  suggestions: string[];
  retrievedChunkCount: number;
}

export function TutorAsk({
  placeholder = 'Ask anything about your uploaded materials…',
  compact = false,
}: {
  placeholder?: string;
  compact?: boolean;
}) {
  const [query, setQuery] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [answer, setAnswer] = React.useState<AskResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!query.trim() || pending) return;
    setPending(true);
    setError(null);
    setAnswer({ refusal: false, text: '', citations: [], suggestions: [], retrievedChunkCount: 0 });
    try {
      const res = await fetch(`${API_BASE}/v1/chat/tutor/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-tenant-id': DEV_TENANT_ID,
          'x-user-id': DEV_USER_ID,
          'x-user-email': DEV_USER_EMAIL,
        },
        body: JSON.stringify({ query: query.trim() }),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(detail.slice(0, 200) || `HTTP ${res.status}`);
      }
      let chunkCount = 0;
      let refusal = false;
      let citations: Citation[] = [];
      let textBuf = '';
      await consumeSSE(res.body, (event, data) => {
        if (event === 'meta') {
          chunkCount = Number(data.retrievedChunkCount ?? 0);
        } else if (event === 'delta') {
          const piece = String(data.text ?? '');
          textBuf += piece;
          setAnswer((prev) =>
            prev ? { ...prev, text: textBuf, retrievedChunkCount: chunkCount } : prev,
          );
        } else if (event === 'citations') {
          citations = (data.citations ?? []) as Citation[];
          setAnswer((prev) => (prev ? { ...prev, citations } : prev));
        } else if (event === 'refusal') {
          refusal = true;
          setAnswer((prev) =>
            prev
              ? {
                  ...prev,
                  refusal: true,
                  text: String(data.text ?? ''),
                  citations: [],
                }
              : prev,
          );
        } else if (event === 'error') {
          throw new Error(String(data.message ?? 'stream error'));
        }
      });
      track('tutor.asked', {
        courseId: null,
        retrievedChunks: chunkCount,
        refusal,
      });
      void citations;
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? (err.problem.detail ?? err.problem.title ?? 'Request failed')
          : err instanceof Error
            ? err.message
            : 'Request failed';
      setError(msg);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          disabled={pending}
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/30"
          aria-label="Question for the tutor"
        />
        <button
          type="submit"
          disabled={pending || !query.trim()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {pending ? 'Asking…' : 'Ask'}
        </button>
      </form>

      {error !== null && (
        <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {answer !== null && (
        <article
          className={`rounded-md border p-4 text-sm ${
            answer.refusal
              ? 'border-border bg-muted/30'
              : 'border-border bg-accent/30'
          }`}
        >
          <header className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {answer.refusal ? 'No answer' : 'Answer'}
            </span>
            <span className="text-xs text-muted-foreground">
              {answer.retrievedChunkCount} chunk(s) retrieved · {answer.citations.length} cited
            </span>
          </header>
          <p className="whitespace-pre-wrap leading-relaxed">{answer.text}</p>

          {answer.citations.length > 0 && (
            <div className="mt-4 space-y-1">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Sources
              </p>
              <ul className="space-y-1 text-xs">
                {answer.citations.map((c, i) => (
                  <li key={c.chunkId} className="flex gap-3 text-muted-foreground">
                    <span className="font-mono">[{i + 1}]</span>
                    <span>
                      doc <code className="rounded bg-muted px-1">{c.docId.slice(0, 8)}…</code>
                      {c.page !== null && <> · page {c.page}</>}
                      {' · score '}
                      {c.score.toFixed(3)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {answer.suggestions.length > 0 && (
            <div className="mt-4 space-y-1">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Related from your materials
              </p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {Array.from(new Set(answer.suggestions)).map((s, i) => (
                  <li key={`${i}-${s}`} className="truncate">
                    · {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </article>
      )}
    </div>
  );
}
