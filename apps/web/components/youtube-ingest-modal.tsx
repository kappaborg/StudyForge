'use client';

import { useState } from 'react';
import { track } from '../lib/analytics';
import { apiPost } from '../lib/dev-fetch';
import { useToast } from './toast';

interface Props {
  folderId: string;
  folderName: string;
  onClose: () => void;
  onIngested: (result: { documentId: string; title: string; chunkCount: number }) => void;
}

interface IngestResult {
  uploadId: string;
  state: string;
  documentId: string;
  chunkCount: number;
  title: string;
}

/**
 * Paste-a-YouTube-URL modal. Captions land as a Document in the active
 * folder identical to a PDF upload — same retrieval, same SRS, same
 * scope-aware tutoring. No file transfer; the worker fetches captions
 * directly from YouTube.
 *
 * Honest about failure modes: when captions are disabled, missing, or
 * the video is unavailable, we surface the worker's problem-detail
 * verbatim so the user knows what to do (try another video, etc.).
 */
export function YouTubeIngestModal({ folderId, folderName, onClose, onIngested }: Props) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<IngestResult>('/v1/uploads/youtube', {
        url: url.trim(),
        folderId,
      });
      track('youtube.ingested', {
        documentId: res.documentId,
        chunkCount: res.chunkCount,
      });
      toast.success(`"${res.title}" added and indexed.`);
      onIngested({
        documentId: res.documentId,
        title: res.title,
        chunkCount: res.chunkCount,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not ingest the video');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-selection-ignore
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-24"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-xl">
        <header className="mb-3">
          <h3 className="text-base font-semibold">Add from YouTube</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Paste a YouTube URL. We pull the captions (manual or
            auto-generated) and add them to <span className="font-medium">{folderName}</span>{' '}
            as a searchable document. No file transfer.
          </p>
        </header>

        <form className="space-y-3" onSubmit={submit}>
          <label className="block text-xs">
            <span className="text-muted-foreground">YouTube URL</span>
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
              autoFocus
              placeholder="https://www.youtube.com/watch?v=…"
              className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/30"
            />
          </label>
          {error && (
            <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
          )}
          <p className="text-[11px] text-muted-foreground">
            Heads up: captions can take a few minutes to appear after a video
            is published. If you hit "no captions" right after release, try
            again later.
          </p>
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
              type="submit"
              disabled={busy || !url.trim()}
              className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Ingesting…' : 'Ingest video'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
