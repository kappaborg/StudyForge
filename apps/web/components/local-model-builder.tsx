'use client';

import { useCallback, useState } from 'react';
import { EMBEDDER_DIM, EMBEDDER_ID, embedBatch, warmEmbedder } from '../lib/client-embedder';
import {
  createLocalModel,
  fetchChunks,
  markBuilt,
  markFailed,
} from '../lib/local-models-client';
import { saveIndex } from '../lib/local-models-db';
import { useAuth } from './auth-gate';

type BuildStage =
  | { kind: 'idle' }
  | { kind: 'register' }
  | { kind: 'fetch' }
  | { kind: 'model-download'; progress: number; file: string }
  | { kind: 'embed'; done: number; total: number }
  | { kind: 'persist' }
  | { kind: 'done'; chunkCount: number; sizeBytes: number }
  | { kind: 'error'; message: string };

/**
 * Builds (or rebuilds) a per-folder local model. End-to-end the flow is:
 *
 *  1. POST /v1/local-models  → register a row in `building` status
 *  2. GET  /v1/local-models/:id/chunks  → pull the chunk bundle
 *  3. Warm transformers.js (downloads the embedder weights on first run)
 *  4. Embed all chunks client-side in batches
 *  5. Write the index to IndexedDB
 *  6. POST /v1/local-models/:id/mark-built  → flip to `ready`
 */
export function LocalModelBuilder({
  folderId,
  folderName,
  onBuilt,
  size = 'normal',
}: {
  folderId: string;
  folderName: string;
  onBuilt?: () => void;
  size?: 'normal' | 'compact';
}) {
  const [stage, setStage] = useState<BuildStage>({ kind: 'idle' });
  const { me } = useAuth();

  const run = useCallback(async () => {
    if (!me) {
      setStage({ kind: 'error', message: 'You must be signed in.' });
      return;
    }
    let modelId: string | null = null;
    try {
      setStage({ kind: 'register' });
      const model = await createLocalModel(folderId);
      modelId = model.id;

      setStage({ kind: 'fetch' });
      const chunks = await fetchChunks(model.id);
      if (chunks.length === 0) {
        throw new Error(
          'No materials in this folder yet. Upload a document first.',
        );
      }

      setStage({ kind: 'model-download', progress: 0, file: 'embedder' });
      await warmEmbedder((evt) => {
        if (evt.status === 'progress' && typeof evt.progress === 'number') {
          setStage({
            kind: 'model-download',
            progress: evt.progress,
            file: evt.file ?? 'embedder',
          });
        }
      });

      setStage({ kind: 'embed', done: 0, total: chunks.length });
      const vectors = await embedBatch(
        chunks.map((c) => c.content),
        (done, total) => setStage({ kind: 'embed', done, total }),
      );

      setStage({ kind: 'persist' });
      const sizeBytes = estimateSize(chunks, vectors);
      await saveIndex(
        {
          userId: me.userId,
          folderId,
          modelId: model.id,
          builtAt: Date.now(),
          embedderId: EMBEDDER_ID,
          embedderDim: EMBEDDER_DIM,
          chunkCount: chunks.length,
          bytesEstimate: sizeBytes,
        },
        chunks.map((c, i) => {
          const vec = vectors[i];
          if (!vec) throw new Error('Vector missing for chunk ' + c.chunkId);
          return {
            chunkId: c.chunkId,
            docId: c.docId,
            filename: c.filename,
            page: c.page,
            content: c.content,
            vector: vec,
          };
        }),
      );

      await markBuilt(model.id, {
        chunkCount: chunks.length,
        sizeBytes,
        embedderId: EMBEDDER_ID,
        embedderDim: EMBEDDER_DIM,
      });

      setStage({ kind: 'done', chunkCount: chunks.length, sizeBytes });
      onBuilt?.();
    } catch (err) {
      setStage({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Build failed',
      });
      if (modelId) await markFailed(modelId).catch(() => undefined);
    }
  }, [folderId, onBuilt, me]);

  const inProgress =
    stage.kind === 'register' ||
    stage.kind === 'fetch' ||
    stage.kind === 'model-download' ||
    stage.kind === 'embed' ||
    stage.kind === 'persist';

  const compact = size === 'compact';

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <button
        type="button"
        onClick={() => void run()}
        disabled={inProgress}
        className={`rounded-md ${
          compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
        } font-medium ${
          inProgress
            ? 'cursor-not-allowed bg-muted text-muted-foreground'
            : 'bg-foreground text-background hover:opacity-90'
        }`}
      >
        {inProgress ? labelFor(stage) : `Build offline tutor for "${folderName}"`}
      </button>

      {inProgress && <BuildProgress stage={stage} />}

      {stage.kind === 'done' && (
        <p className={`${compact ? 'text-xs' : 'text-sm'} text-emerald-700`}>
          ✓ Offline tutor ready · {stage.chunkCount} chunks ·{' '}
          {formatBytes(stage.sizeBytes)}
        </p>
      )}

      {stage.kind === 'error' && (
        <p className={`${compact ? 'text-xs' : 'text-sm'} rounded bg-rose-50 px-3 py-2 text-rose-700`}>
          {stage.message}
        </p>
      )}
    </div>
  );
}

function BuildProgress({ stage }: { stage: BuildStage }) {
  let pct = 0;
  let detail = '';
  if (stage.kind === 'register') {
    pct = 5;
    detail = 'Reserving offline-model slot…';
  } else if (stage.kind === 'fetch') {
    pct = 12;
    detail = 'Loading your materials…';
  } else if (stage.kind === 'model-download') {
    pct = 15 + stage.progress * 0.35;
    detail = `Downloading embedder (${stage.file}) — first build only`;
  } else if (stage.kind === 'embed') {
    pct = 50 + (stage.done / Math.max(1, stage.total)) * 40;
    detail = `Embedding chunk ${stage.done} / ${stage.total}…`;
  } else if (stage.kind === 'persist') {
    pct = 95;
    detail = 'Writing index to local storage…';
  }
  return (
    <div className="space-y-1">
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-foreground transition-all"
          style={{ width: `${Math.round(pct)}%` }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function labelFor(stage: BuildStage): string {
  switch (stage.kind) {
    case 'register':
      return 'Reserving…';
    case 'fetch':
      return 'Loading materials…';
    case 'model-download':
      return `Downloading embedder ${Math.round(stage.progress)}%`;
    case 'embed':
      return `Embedding ${stage.done}/${stage.total}…`;
    case 'persist':
      return 'Writing index…';
    default:
      return 'Building…';
  }
}

function estimateSize(
  chunks: Array<{ content: string }>,
  vectors: Float32Array[],
): number {
  // Rough but defensible: 4 bytes per dim + UTF-8-ish text length.
  let bytes = 0;
  for (const v of vectors) bytes += v.byteLength;
  for (const c of chunks) bytes += c.content.length * 2;
  return bytes;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
