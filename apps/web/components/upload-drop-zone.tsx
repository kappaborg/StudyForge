'use client';

import * as React from 'react';
import { track } from '../lib/analytics';

/**
 * Multi-file client-side upload flow:
 *
 *   1. compute sha256 of the file (browser SubtleCrypto)
 *   2. POST /v1/uploads/init  → { uploadId, signedUrl, s3Key, expiresAt }
 *   3. PUT file → signedUrl   (direct to MinIO, browser-to-S3)
 *   4. POST /v1/uploads/{id}/complete → { state: 'ready', documentId, chunkCount }
 *
 * Up to MAX_CONCURRENCY files run in parallel; the rest queue. Each file
 * gets its own row with a per-file progress bar and final status. Picker +
 * drag-drop both accept multiple files. The destination folder is the same
 * for every file in the batch — the parent picks it.
 */

type JobStage =
  | { kind: 'queued' }
  | { kind: 'hashing' }
  | { kind: 'initing' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'completing' }
  | { kind: 'done'; documentId?: string; chunkCount?: number }
  | { kind: 'error'; message: string };

interface UploadJob {
  id: string;
  file: File;
  stage: JobStage;
}

// Matches the canonical API_BASE in lib/dev-fetch.ts. In production
// the FE goes through Vercel's edge rewrites so requests are
// same-origin from the browser's perspective and the session cookie
// (which lives on the Vercel domain) is sent. Calling the Render URL
// directly in production lands the cookie in cross-site territory
// and triggers 401 "Not signed in" on every upload init.
const API_BASE =
  process.env['NEXT_PUBLIC_AUTH_MODE'] === 'production'
    ? ''
    : (process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:3001');

const DEV_TENANT_ID = '11111111-1111-1111-1111-111111111111';
const DEV_USER_ID = '22222222-2222-2222-2222-222222222222';
const DEV_USER_EMAIL = 'dev@studyforge.local';

const MAX_CONCURRENCY = 3;
// Files at or above this size go through S3 multipart. Smaller files
// stay on the single-shot PUT path — multipart has overhead (extra
// init call, per-part signing) that's pointless on a 200 KB PDF.
const MULTIPART_THRESHOLD = 5 * 1024 * 1024;
const PART_SIZE = 5 * 1024 * 1024;
// Cap on parallel UploadPart requests per file. Per-file concurrency
// matters less than per-upload-zone concurrency because S3 throttles
// per-key writes anyway.
const PART_CONCURRENCY = 3;

const SUPPORTED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/svg+xml',
  'application/x-ipynb+json',
  'application/json',
  'text/plain',
  'text/markdown',
  // Audio (transcribed via faster-whisper on the worker)
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/webm',
  'audio/ogg',
  'audio/x-m4a',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
]);
const SUPPORTED_EXT = [
  '.pdf', '.pptx', '.docx', '.ipynb', '.txt', '.md', '.markdown', '.json',
  '.mp3', '.wav', '.m4a', '.webm', '.ogg', '.aac', '.flac',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif',
];

function isSupported(file: File): boolean {
  if (SUPPORTED_MIME.has(file.type)) return true;
  const lower = file.name.toLowerCase();
  return SUPPORTED_EXT.some((ext) => lower.endsWith(ext));
}

export function UploadDropZone({ folderId }: { folderId?: string | null } = {}) {
  const [jobs, setJobs] = React.useState<UploadJob[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Track running job ids so the queue runner doesn't re-launch in-flight
  // work after every state update. A ref avoids stale-closure pitfalls.
  const runningRef = React.useRef<Set<string>>(new Set());
  const jobsRef = React.useRef<UploadJob[]>([]);
  jobsRef.current = jobs;

  const updateJob = React.useCallback(
    (id: string, patch: Partial<UploadJob> | ((j: UploadJob) => UploadJob)) => {
      setJobs((prev) =>
        prev.map((j) =>
          j.id === id ? (typeof patch === 'function' ? patch(j) : { ...j, ...patch }) : j,
        ),
      );
    },
    [],
  );

  const runJob = React.useCallback(
    async (job: UploadJob) => {
      runningRef.current.add(job.id);
      const startedAt = performance.now();
      try {
        track('upload.started', {
          mime: job.file.type || 'unknown',
          sizeBytes: job.file.size,
          multipart: job.file.size >= MULTIPART_THRESHOLD,
        });

        updateJob(job.id, { stage: { kind: 'hashing' } });
        const sha256 = await sha256Hex(job.file);

        updateJob(job.id, { stage: { kind: 'initing' } });
        // Files ≥ 5 MB take the multipart path — failed chunks retry
        // individually instead of forcing the whole file to start over.
        const useMultipart = job.file.size >= MULTIPART_THRESHOLD;
        const init = await postJson<{
          uploadId: string;
          multipart: boolean;
          signedUrl?: string;
          parts?: Array<{ partNumber: number; signedUrl: string }>;
          expiresAt: string;
        }>(`${API_BASE}/v1/uploads/init`, {
          filename: job.file.name,
          mime: job.file.type || 'application/pdf',
          sizeBytes: job.file.size,
          sha256,
          ...(useMultipart ? { multipart: true } : {}),
          ...(folderId ? { folderId } : {}),
        });

        updateJob(job.id, { stage: { kind: 'uploading', progress: 0 } });
        let completedParts:
          | Array<{ partNumber: number; etag: string }>
          | undefined;
        if (init.multipart && init.parts) {
          completedParts = await uploadParts(job.file, init.parts, (pct) => {
            updateJob(job.id, { stage: { kind: 'uploading', progress: pct } });
          });
        } else if (init.signedUrl) {
          await putWithProgress(init.signedUrl, job.file, (pct) => {
            updateJob(job.id, { stage: { kind: 'uploading', progress: pct } });
          });
        } else {
          throw new Error('Init response missing both signedUrl and parts');
        }

        updateJob(job.id, { stage: { kind: 'completing' } });
        const complete = await postJson<{
          state: string;
          documentId?: string;
          chunkCount?: number;
        }>(`${API_BASE}/v1/uploads/${init.uploadId}/complete`,
          completedParts ? { parts: completedParts } : {});

        updateJob(job.id, {
          stage: {
            kind: 'done',
            documentId: complete.documentId,
            chunkCount: complete.chunkCount,
          },
        });
        track('upload.completed', {
          documentId: complete.documentId ?? 'unknown',
          chunkCount: complete.chunkCount ?? 0,
          durationMs: Math.round(performance.now() - startedAt),
          multipart: init.multipart === true,
        });
      } catch (err) {
        updateJob(job.id, {
          stage: {
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      } finally {
        runningRef.current.delete(job.id);
      }
    },
    [folderId, updateJob],
  );

  // Pump the queue: whenever a slot frees up, launch the next queued job.
  // Driven by a state-change effect so it re-checks on every job update.
  React.useEffect(() => {
    while (runningRef.current.size < MAX_CONCURRENCY) {
      const next = jobsRef.current.find(
        (j) => j.stage.kind === 'queued' && !runningRef.current.has(j.id),
      );
      if (!next) break;
      runningRef.current.add(next.id); // claim before await so other ticks don't pick it
      // Kick off but don't await — finally clears the ref and the next
      // queued job starts on the next render cycle.
      void runJob(next);
    }
  }, [jobs, runJob]);

  const enqueueFiles = React.useCallback((fileList: FileList | File[]) => {
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;
    const additions: UploadJob[] = [];
    for (const file of incoming) {
      if (!isSupported(file)) {
        additions.push({
          id: localId(),
          file,
          stage: {
            kind: 'error',
            message: `Unsupported file type: ${file.type || 'unknown'}.`,
          },
        });
        continue;
      }
      additions.push({ id: localId(), file, stage: { kind: 'queued' } });
    }
    setJobs((prev) => [...prev, ...additions]);
  }, []);

  const onPickerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (list && list.length > 0) enqueueFiles(list);
    // Reset value so picking the same files again still fires onChange.
    e.target.value = '';
  };

  const clearFinished = () => {
    setJobs((prev) =>
      prev.filter((j) => j.stage.kind !== 'done' && j.stage.kind !== 'error'),
    );
  };

  const removeJob = (id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  };

  const counts = summarizeJobs(jobs);

  return (
    <div className="space-y-4">
      <label
        htmlFor="file-input"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (e.dataTransfer.files.length > 0) enqueueFiles(e.dataTransfer.files);
        }}
        className={`block cursor-pointer rounded-lg border-2 border-dashed p-12 text-center transition-colors ${
          isDragging
            ? 'border-foreground bg-accent'
            : 'border-border hover:border-foreground/40'
        }`}
      >
        <input
          ref={inputRef}
          id="file-input"
          type="file"
          multiple
          accept=".pdf,.pptx,.docx,.ipynb,.txt,.md,.json,.mp3,.wav,.m4a,.webm,.ogg,.aac,.flac,.png,.jpg,.jpeg,.webp,.bmp,.tiff,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/x-ipynb+json,text/plain,text/markdown,application/json,audio/*,image/*"
          className="sr-only"
          onChange={onPickerChange}
        />
        <p className="text-sm font-medium">
          Drop PDFs / slides / notes / audio / screenshots here, or click to choose
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Multiple files OK · audio transcribed · images scanned for text · up to {MAX_CONCURRENCY} at once
        </p>
      </label>

      {jobs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {counts.done}/{jobs.length} done
              {counts.error > 0 && ` · ${counts.error} failed`}
              {counts.active > 0 && ` · ${counts.active} uploading`}
              {counts.queued > 0 && ` · ${counts.queued} queued`}
            </span>
            {(counts.done > 0 || counts.error > 0) && (
              <button
                type="button"
                onClick={clearFinished}
                className="hover:text-foreground"
              >
                Clear finished
              </button>
            )}
          </div>
          <ul className="space-y-2">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} onRemove={() => removeJob(j.id)} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function JobRow({ job, onRemove }: { job: UploadJob; onRemove: () => void }) {
  const pct = stagePct(job.stage);
  const done = job.stage.kind === 'done';
  const error = job.stage.kind === 'error';
  return (
    <li className="rounded-md border border-border bg-background p-3 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{job.file.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {labelFor(job.stage)} · {formatBytes(job.file.size)}
          </p>
        </div>
        {(done || error) && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Dismiss"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        )}
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full transition-all ${
            error ? 'bg-destructive' : done ? 'bg-emerald-500' : 'bg-foreground'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {job.stage.kind === 'done' && job.stage.documentId && (
        <p className="mt-1 text-xs text-muted-foreground">
          Indexed {job.stage.chunkCount ?? '?'} chunk
          {job.stage.chunkCount === 1 ? '' : 's'} · doc{' '}
          <code className="rounded bg-muted px-1">{job.stage.documentId.slice(0, 8)}…</code>
        </p>
      )}
      {job.stage.kind === 'error' && (
        <p className="mt-1 text-xs text-destructive">{job.stage.message}</p>
      )}
    </li>
  );
}

function stagePct(stage: JobStage): number {
  switch (stage.kind) {
    case 'queued':
      return 0;
    case 'hashing':
      return 10;
    case 'initing':
      return 20;
    case 'uploading':
      return 20 + stage.progress * 0.6;
    case 'completing':
      return 85;
    case 'done':
      return 100;
    case 'error':
      return 100;
  }
}

function labelFor(stage: JobStage): string {
  switch (stage.kind) {
    case 'queued':
      return 'Queued';
    case 'hashing':
      return 'Hashing…';
    case 'initing':
      return 'Reserving storage…';
    case 'uploading':
      return `Uploading… ${Math.round(stage.progress)}%`;
    case 'completing':
      return 'Indexing…';
    case 'done':
      return 'Ready';
    case 'error':
      return 'Failed';
  }
}

function summarizeJobs(jobs: UploadJob[]) {
  let done = 0;
  let error = 0;
  let active = 0;
  let queued = 0;
  for (const j of jobs) {
    switch (j.stage.kind) {
      case 'done':
        done++;
        break;
      case 'error':
        error++;
        break;
      case 'queued':
        queued++;
        break;
      default:
        active++;
    }
  }
  return { done, error, active, queued };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function localId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function postJson<T>(url: string, body: object): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': newIdempotencyKey(),
      'x-tenant-id': DEV_TENANT_ID,
      'x-user-id': DEV_USER_ID,
      'x-user-email': DEV_USER_EMAIL,
    },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const problem = JSON.parse(text);
      detail = problem.detail ?? problem.title ?? text;
    } catch {
      // not JSON, keep raw text
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

function putWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', file.type || 'application/pdf');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress((e.loaded / e.total) * 100);
      }
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`PUT ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
    });
    xhr.addEventListener('error', () => reject(new Error('upload failed')));
    xhr.send(file);
  });
}

/**
 * S3 multipart upload — PUT each slice of the file to its pre-signed
 * UploadPart URL, then return the {partNumber, etag} array the complete
 * endpoint needs to call CompleteMultipartUpload.
 *
 * Each part runs through ``putPartWithEtag`` which extracts the ETag
 * response header. The browser exposes ETag on cross-origin XHR only
 * when the bucket's CORS policy lists ``ETag`` in ``ExposeHeaders`` — if
 * that's missing the part upload succeeds at S3 but the client can't
 * read the tag, and complete fails. Document this in the README so the
 * misconfiguration is fixable.
 *
 * Concurrency is capped to keep memory bounded (each in-flight part is
 * a 5 MB Blob slice held in RAM). A tiny worker-pool pattern pulls the
 * next part as one finishes.
 */
async function uploadParts(
  file: File,
  parts: Array<{ partNumber: number; signedUrl: string }>,
  onProgress: (pct: number) => void,
): Promise<Array<{ partNumber: number; etag: string }>> {
  const total = file.size;
  // ``loaded`` is the cumulative bytes across all parts. We aggregate
  // per-part progress events into a global percentage.
  const perPartLoaded = new Map<number, number>();
  const tickProgress = () => {
    let loaded = 0;
    for (const v of perPartLoaded.values()) loaded += v;
    onProgress(Math.min(100, (loaded / total) * 100));
  };

  const results = new Map<number, string>();
  let nextIdx = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const idx = nextIdx++;
      if (idx >= parts.length) return;
      const part = parts[idx]!;
      const start = idx * PART_SIZE;
      const end = Math.min(start + PART_SIZE, total);
      const slice = file.slice(start, end);
      let etag: string | null;
      try {
        etag = await putPartWithEtag(part.signedUrl, slice, (bytes) => {
          perPartLoaded.set(part.partNumber, bytes);
          tickProgress();
        });
      } catch (err) {
        track('multipart.part_failed', {
          partNumber: part.partNumber,
          partCount: parts.length,
          sizeBytes: total,
        });
        throw err;
      }
      if (!etag) {
        throw new Error(
          `Part ${part.partNumber} succeeded but no ETag header was readable. The S3/MinIO bucket needs ETag in ExposeHeaders (CORS).`,
        );
      }
      results.set(part.partNumber, etag);
      // Mark this part as fully uploaded in the aggregate.
      perPartLoaded.set(part.partNumber, end - start);
      tickProgress();
    }
  }

  const workers = Array.from({ length: Math.min(PART_CONCURRENCY, parts.length) }, () => worker());
  await Promise.all(workers);

  return parts
    .map((p) => ({ partNumber: p.partNumber, etag: results.get(p.partNumber)! }))
    .filter((p) => Boolean(p.etag));
}

function putPartWithEtag(
  url: string,
  blob: Blob,
  onProgress: (bytes: number) => void,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // Don't set Content-Type — S3 signed the URL without one, and a
    // mismatched header invalidates the signature.
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag');
        resolve(etag);
      } else {
        reject(new Error(`Part PUT ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Part upload failed')));
    xhr.send(blob);
  });
}

function newIdempotencyKey(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return (
    'key_' +
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  );
}
