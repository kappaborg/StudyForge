'use client';

import { useEffect, useRef, useState } from 'react';
import { hasWebGPU } from '@studyforge/webllm-client';

type Stage =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'unsupported' }
  | { kind: 'downloading'; progress: number; label: string }
  | { kind: 'ready' }
  | { kind: 'answering'; answer: string }
  | { kind: 'error'; message: string };

// llama-3.2-1b-instruct-q4f16_1-MLC is ~700MB; phi-3.5-mini is larger.
// Pick the smallest decent model so the download UX is tolerable.
const MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

export function LocalTutor() {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [question, setQuestion] = useState('');
  const engineRef = useRef<unknown>(null);

  useEffect(() => {
    (async () => {
      setStage({ kind: 'checking' });
      const ok = await hasWebGPU();
      setStage(ok ? { kind: 'idle' } : { kind: 'unsupported' });
    })();
  }, []);

  const loadModel = async () => {
    setStage({ kind: 'downloading', progress: 0, label: 'starting…' });
    try {
      // Dynamic import keeps the ~1MB WebLLM runtime out of the initial
      // bundle until the user explicitly opts in.
      const webllm = await import('@mlc-ai/web-llm');
      const engine = await webllm.CreateMLCEngine(MODEL_ID, {
        initProgressCallback: (report: { progress: number; text: string }) => {
          setStage({
            kind: 'downloading',
            progress: report.progress,
            label: report.text,
          });
        },
      });
      engineRef.current = engine;
      setStage({ kind: 'ready' });
    } catch (err) {
      setStage({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Model load failed',
      });
    }
  };

  const ask = async () => {
    const engine = engineRef.current as
      | { chat: { completions: { create: (opts: object) => Promise<unknown> } } }
      | null;
    if (!engine || !question.trim()) return;
    setStage({ kind: 'answering', answer: '' });
    try {
      const completion = (await engine.chat.completions.create({
        messages: [
          {
            role: 'system',
            content:
              'You are StudyForge, a concise local-AI helper. Answer in under 120 words.',
          },
          { role: 'user', content: question.trim() },
        ],
        max_tokens: 256,
        temperature: 0.3,
      })) as { choices: Array<{ message: { content: string } }> };
      const text = completion.choices[0]?.message.content ?? '(no answer)';
      setStage({ kind: 'answering', answer: text });
    } catch (err) {
      setStage({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Inference failed',
      });
    }
  };

  return (
    <section className="rounded-lg border border-border p-4 space-y-3">
      <header>
        <h3 className="text-sm font-semibold">Local AI (WebGPU)</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Runs a 1B-parameter model entirely in your browser via WebGPU. The
          first session downloads ~700 MB; subsequent loads are instant.
          No data leaves your machine.
        </p>
      </header>

      {stage.kind === 'checking' && (
        <p className="text-xs text-muted-foreground">Checking WebGPU support…</p>
      )}

      {stage.kind === 'unsupported' && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800">
          Your browser doesn't expose WebGPU. Try Chrome / Edge / Safari Technology
          Preview on a recent desktop GPU. The cloud tutor on the dashboard
          works without WebGPU.
        </p>
      )}

      {stage.kind === 'idle' && (
        <button
          onClick={() => void loadModel()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
        >
          Download model + start
        </button>
      )}

      {stage.kind === 'downloading' && (
        <div className="space-y-2">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-foreground transition-all"
              style={{ width: `${Math.round(stage.progress * 100)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">{stage.label}</p>
        </div>
      )}

      {(stage.kind === 'ready' || stage.kind === 'answering') && (
        <div className="space-y-2">
          <label htmlFor="local-tutor-q" className="sr-only">
            Question for the browser-local model
          </label>
          <textarea
            id="local-tutor-q"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask the local model anything"
            rows={3}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <button
            onClick={() => void ask()}
            disabled={!question.trim() || stage.kind === 'answering'}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {stage.kind === 'answering' && !stage.answer ? 'Thinking…' : 'Ask locally'}
          </button>
          {stage.kind === 'answering' && stage.answer && (
            <article className="rounded-md border border-border bg-muted/20 p-3 text-sm whitespace-pre-wrap">
              {stage.answer}
            </article>
          )}
        </div>
      )}

      {stage.kind === 'error' && (
        <p className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-800">
          {stage.message}
        </p>
      )}
    </section>
  );
}
