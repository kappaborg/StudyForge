'use client';

import { useEffect, useRef, useState } from 'react';
import {
  API_BASE,
  DEV_TENANT_ID,
  DEV_USER_EMAIL,
  DEV_USER_ID,
} from '../lib/dev-fetch';
import { VoiceInputButton } from './voice-input-button';
import { VoiceOutputButton } from './voice-output-button';

interface Props {
  selection: string;
  folderId: string | null;
  onClose: () => void;
}

/**
 * "Explain this" modal. Pre-fills with the highlighted text + a sensible
 * default question, lets the student tweak, then streams a folder-scoped
 * answer inline. Keeps the conversation focused on the highlight — we
 * don't persist these into a chat session; they're scratch lookups.
 */
export function AskAboutSheet({ selection, folderId, onClose }: Props) {
  const [question, setQuestion] = useState('Explain this in plain language.');
  const [answer, setAnswer] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const send = async () => {
    setPending(true);
    setAnswer('');
    setError(null);
    const composed = `Quoted passage:\n"${selection.slice(0, 2000)}"\n\nQuestion: ${question.trim() || 'Explain this in plain language.'}`;
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
        body: JSON.stringify({
          query: composed,
          ...(folderId ? { folderId } : {}),
        }),
        credentials: 'include',
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let ev = 'message';
          const dataParts: string[] = [];
          for (const ln of frame.split('\n')) {
            if (ln.startsWith('event:')) ev = ln.slice(6).trim();
            else if (ln.startsWith('data:')) dataParts.push(ln.slice(5).trim());
          }
          if (dataParts.length === 0) continue;
          try {
            const data = JSON.parse(dataParts.join('\n')) as Record<string, unknown>;
            if (ev === 'delta') {
              acc += String(data['text'] ?? '');
              setAnswer(acc);
            } else if (ev === 'done') {
              const t = data['text'];
              if (typeof t === 'string' && t.length > 0) {
                acc = t;
                setAnswer(acc);
              }
            } else if (ev === 'refusal') {
              acc = String(data['text'] ?? acc);
              setAnswer(acc);
            } else if (ev === 'error') {
              throw new Error(String(data['message'] ?? 'stream error'));
            }
          } catch {
            // Skip bad frames
          }
          sep = buf.indexOf('\n\n');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setPending(false);
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
      <div className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-xl sm:p-5">
        <header className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold">Ask about this</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {folderId
                ? 'Scoped to the current folder'
                : 'Searching all your materials'}
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

        <blockquote className="mb-3 rounded border-l-4 border-foreground/30 bg-muted/30 p-3 text-sm italic">
          {selection.length > 500 ? selection.slice(0, 500) + '…' : selection}
        </blockquote>

        <textarea
          ref={ref}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          disabled={pending}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          className="block w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/30"
        />

        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">Cmd/Ctrl+Enter to send</p>
          <div className="flex items-center gap-2">
            <VoiceInputButton
              disabled={pending}
              compact
              onTranscript={(text, final) => {
                if (!final) return;
                setQuestion((prev) => (prev ? prev.trimEnd() + ' ' + text : text));
              }}
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={pending || !question.trim()}
              className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {pending && !answer ? 'Thinking…' : pending ? 'Answering…' : 'Ask'}
            </button>
          </div>
        </div>

        {answer && (
          <article className="mt-4 rounded-md border border-border bg-accent/30 p-4 text-sm">
            <p className="whitespace-pre-wrap leading-relaxed">{answer}</p>
            <div className="mt-2 flex justify-end">
              <VoiceOutputButton text={answer} />
            </div>
          </article>
        )}

        {error && (
          <p className="mt-3 rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
        )}
      </div>
    </div>
  );
}
