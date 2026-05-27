'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { hasWebGPU } from '@studyforge/webllm-client';
import { cosine, embed, warmEmbedder } from '../lib/client-embedder';
import { relativeTime } from '../lib/format-document';
import { loadChunks, loadMeta, type LocalChunk, type LocalIndexMeta } from '../lib/local-models-db';
import { useAuth } from './auth-gate';
import { CitationLink } from './citation-link';
import { VoiceInputButton } from './voice-input-button';
import { VoiceOutputButton } from './voice-output-button';

/**
 * Offline tutor: WebLLM-driven Llama 3.2 1B + browser-local RAG against a
 * folder's IndexedDB index. Renders only when an index exists for the
 * requested folder. Fully usable without a network after the first model
 * download + index build.
 *
 * Inference pipeline per question:
 *
 *   1. embed the question with @huggingface/transformers (same model used
 *      to build the index, so vectors live in the same space)
 *   2. cosine top-K against the in-memory chunk vectors
 *   3. inject the chunks into the system prompt as numbered context blocks
 *   4. WebLLM streams the answer; the UI tags each [n] back to a chunk
 */

const MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
const TOP_K = 5;

type Stage =
  | { kind: 'checking' }
  | { kind: 'unsupported' }
  | { kind: 'no-index' }
  | { kind: 'loading-index' }
  | { kind: 'idle' }
  | { kind: 'downloading-llm'; progress: number; label: string }
  | { kind: 'answering'; partial: string; sources: SourceCitation[] }
  | { kind: 'error'; message: string };

interface SourceCitation {
  ord: number; // 1-based index in the citation tray
  chunkId: string;
  docId: string;
  filename: string;
  page: number | null;
  score: number;
}

interface QATurn {
  question: string;
  answer: string;
  sources: SourceCitation[];
}

export function OfflineTutor({ folderId }: { folderId: string }) {
  const { me } = useAuth();
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const [meta, setMeta] = useState<LocalIndexMeta | null>(null);
  const [chunks, setChunks] = useState<LocalChunk[]>([]);
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<QATurn[]>([]);
  const engineRef = useRef<null | {
    chat: {
      completions: {
        create: (opts: object) => AsyncIterable<{
          choices: Array<{ delta?: { content?: string } }>;
        }>;
      };
    };
  }>(null);
  const llmReadyRef = useRef(false);

  // Bootstrap: capability check, load index from IDB.
  useEffect(() => {
    if (!me) return;
    (async () => {
      const ok = await hasWebGPU();
      if (!ok) {
        setStage({ kind: 'unsupported' });
        return;
      }
      setStage({ kind: 'loading-index' });
      try {
        const m = await loadMeta(me.userId, folderId);
        if (!m) {
          setStage({ kind: 'no-index' });
          return;
        }
        setMeta(m);
        const cs = await loadChunks(me.userId, folderId);
        if (cs.length === 0) {
          setStage({ kind: 'no-index' });
          return;
        }
        setChunks(cs);
        setStage({ kind: 'idle' });
      } catch (err) {
        setStage({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Failed to load index',
        });
      }
    })();
  }, [folderId, me]);

  const ensureLLM = useCallback(async (): Promise<void> => {
    if (llmReadyRef.current) return;
    setStage({ kind: 'downloading-llm', progress: 0, label: 'starting…' });
    const webllm = await import('@mlc-ai/web-llm');
    const engine = await webllm.CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (report: { progress: number; text: string }) => {
        setStage({
          kind: 'downloading-llm',
          progress: report.progress,
          label: report.text,
        });
      },
    });
    engineRef.current = engine as unknown as typeof engineRef.current;
    llmReadyRef.current = true;
  }, []);

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q) return;
    try {
      await warmEmbedder();
      await ensureLLM();

      // ── retrieve ─────────────────────────────────────────────────────────
      const qVec = await embed(q);
      const scored = chunks.map((c) => ({ c, score: cosine(qVec, c.vector) }));
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, TOP_K);
      const sources: SourceCitation[] = top.map((t, i) => ({
        ord: i + 1,
        chunkId: t.c.chunkId,
        docId: t.c.docId,
        filename: t.c.filename,
        page: t.c.page,
        score: t.score,
      }));

      // ── compose prompt ───────────────────────────────────────────────────
      const contextBlock = top
        .map(
          (t, i) =>
            `[${i + 1}] (${t.c.filename}${
              t.c.page !== null ? `, p.${t.c.page}` : ''
            }) ${t.c.content}`,
        )
        .join('\n\n');
      const systemPrompt = [
        'You are StudyForge\'s offline tutor. Answer the student\'s question using ONLY the numbered context blocks below.',
        'Cite the blocks you used with [1], [2] etc. inline.',
        'If the context does not contain the answer, say so clearly — do not invent facts.',
        '',
        'Context:',
        contextBlock,
      ].join('\n');

      // ── stream ───────────────────────────────────────────────────────────
      setStage({ kind: 'answering', partial: '', sources });
      const engine = engineRef.current;
      if (!engine) throw new Error('LLM engine not ready');
      const completion = await engine.chat.completions.create({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: q },
        ],
        max_tokens: 512,
        temperature: 0.2,
        stream: true,
      });
      let acc = '';
      for await (const part of completion) {
        const piece = part.choices?.[0]?.delta?.content ?? '';
        if (!piece) continue;
        acc += piece;
        setStage({ kind: 'answering', partial: acc, sources });
      }

      setHistory((prev) => [...prev, { question: q, answer: acc, sources }]);
      setStage({ kind: 'idle' });
      setQuestion('');
    } catch (err) {
      setStage({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Inference failed',
      });
    }
  }, [question, chunks, ensureLLM]);

  return (
    <section className="space-y-4">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Offline tutor</h1>
          {meta && (
            <p className="mt-1 text-xs text-muted-foreground">
              Built {relativeTime(new Date(meta.builtAt).toISOString())} · runs entirely in your browser
            </p>
          )}
        </div>
      </header>

      {stage.kind === 'checking' && (
        <p className="text-xs text-muted-foreground">Checking WebGPU support…</p>
      )}

      {stage.kind === 'unsupported' && (
        <p className="rounded-md border border-amber-500/30 bg-amber-50 p-3 text-xs text-amber-800">
          Your browser doesn't expose WebGPU. Try Chrome / Edge on a recent
          desktop GPU. The cloud tutor on the dashboard works without WebGPU.
        </p>
      )}

      {stage.kind === 'no-index' && (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm">
          <p>No offline index exists for this folder yet.</p>
          <Link
            href={`/folders/${folderId}`}
            className="mt-2 inline-block text-foreground underline"
          >
            Build the offline tutor first
          </Link>
        </div>
      )}

      {stage.kind === 'loading-index' && (
        <p className="text-xs text-muted-foreground">Loading offline index…</p>
      )}

      {stage.kind === 'downloading-llm' && (
        <div className="space-y-1 rounded-md border border-border bg-muted/20 p-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-foreground transition-all"
              style={{ width: `${Math.round(stage.progress * 100)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            First-run download: 1B-parameter Llama (~700 MB). Cached after this.
          </p>
          <p className="text-[11px] text-muted-foreground">{stage.label}</p>
        </div>
      )}

      {(stage.kind === 'idle' || stage.kind === 'answering' || stage.kind === 'error') &&
        chunks.length > 0 && (
          <div className="space-y-4">
            {history.length > 0 && (
              <div className="space-y-3">
                {history.map((turn, i) => (
                  <Turn key={i} turn={turn} folderId={folderId} />
                ))}
              </div>
            )}

            {stage.kind === 'answering' && (
              <div className="space-y-2 rounded-md border border-border bg-accent/30 p-4">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">
                  Answering…
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {stage.partial || (
                    <span className="text-muted-foreground">Retrieving + thinking…</span>
                  )}
                </p>
                <CitationsTray sources={stage.sources} folderId={folderId} />
              </div>
            )}

            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void ask();
              }}
            >
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask anything about this folder's materials. Cmd/Ctrl+Enter to send."
                rows={3}
                disabled={stage.kind === 'answering'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void ask();
                  }
                }}
                className="block w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/30"
              />
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">
                  Nothing leaves your browser. Answers cite the chunks they came from.
                </span>
                <div className="flex items-center gap-2">
                  <VoiceInputButton
                    disabled={stage.kind === 'answering'}
                    compact
                    onTranscript={(text, final) => {
                      if (!final) return;
                      setQuestion((prev) => (prev ? prev.trimEnd() + ' ' + text : text));
                    }}
                  />
                  <button
                    type="submit"
                    disabled={!question.trim() || stage.kind === 'answering'}
                    className="rounded-md bg-foreground px-4 py-1.5 text-xs font-medium text-background disabled:opacity-50"
                  >
                    {stage.kind === 'answering' ? 'Thinking…' : 'Ask offline'}
                  </button>
                </div>
              </div>
            </form>

            {stage.kind === 'error' && (
              <p className="rounded-md border border-rose-500/30 bg-rose-50 p-3 text-xs text-rose-700">
                {stage.message}
              </p>
            )}
          </div>
        )}
    </section>
  );
}

function Turn({ turn, folderId }: { turn: QATurn; folderId: string }) {
  return (
    <article className="space-y-2">
      <div className="rounded-md bg-foreground px-4 py-2 text-sm text-background">
        {turn.question}
      </div>
      <div className="rounded-md border border-border bg-accent/30 p-4 text-sm">
        <p className="whitespace-pre-wrap leading-relaxed">{turn.answer}</p>
        <div className="mt-2 flex justify-end">
          <VoiceOutputButton text={turn.answer} />
        </div>
        <CitationsTray sources={turn.sources} folderId={folderId} />
      </div>
    </article>
  );
}

function CitationsTray({
  sources,
  folderId,
}: {
  sources: SourceCitation[];
  folderId: string;
}) {
  if (sources.length === 0) return null;
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        {sources.length} source{sources.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-2 flex flex-wrap gap-1.5 text-muted-foreground">
        {sources.map((s) => (
          <li key={s.chunkId}>
            <CitationLink
              ord={s.ord}
              source={{
                kind: 'offline',
                folderId,
                chunkId: s.chunkId,
                docId: s.docId,
                page: s.page,
                filename: s.filename,
              }}
              label={`${s.filename}${s.page !== null ? ` · p.${s.page}` : ''}`}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}
