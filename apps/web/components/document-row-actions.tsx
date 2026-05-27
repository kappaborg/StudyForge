'use client';

import { useEffect, useRef, useState } from 'react';
import { API_BASE, DEV_TENANT_ID, DEV_USER_EMAIL, DEV_USER_ID, apiGet } from '../lib/dev-fetch';
import { useToast } from './toast';

interface ImpactDto {
  ingestionInFlight: boolean;
  artifactCounts: {
    flashcardDecks: number;
    quizzes: number;
    roadmaps: number;
    concepts: number;
  };
  folderId: string | null;
}

interface Props {
  documentId: string;
  filename: string;
  trashed: boolean;
  /** Total chunks across all versions. Used to decide whether Deep-index
   * is worth offering — docs with one chunk or less have no structure
   * for the LLM pass to surface. */
  chunkCount: number;
  onChanged: () => void;
}

function devHeaders(): Record<string, string> {
  return {
    'x-tenant-id': DEV_TENANT_ID,
    'x-user-id': DEV_USER_ID,
    'x-user-email': DEV_USER_EMAIL,
  };
}

export function DocumentRowActions({
  documentId,
  filename,
  trashed,
  chunkCount,
  onChanged,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [impact, setImpact] = useState<ImpactDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [deepBusy, setDeepBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const openDeleteModal = async () => {
    setMenuOpen(false);
    setError(null);
    setModalOpen(true);
    setImpact(null);
    try {
      const res = await apiGet<ImpactDto>(`/v1/documents/${documentId}/impact`);
      setImpact(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load impact');
    }
  };

  const confirmDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/v1/documents/${documentId}`, {
        method: 'DELETE',
        headers: devHeaders(),
        credentials: 'include',
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        throw new Error(text || `HTTP ${res.status}`);
      }
      setModalOpen(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const runDeepIndex = async () => {
    setMenuOpen(false);
    setDeepBusy(true);
    try {
      const res = await fetch(`${API_BASE}/v1/documents/${documentId}/deep-index`, {
        method: 'POST',
        headers: { ...devHeaders(), 'content-type': 'application/json' },
        body: '{}',
        credentials: 'include',
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        throw new Error(text || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        updatedChunks: number;
        chaptersFound: number;
        sectionsFound?: number;
        skippedReason: string | null;
      };
      if (json.skippedReason) {
        toast.info(`Deep-index skipped: ${json.skippedReason}`);
      } else {
        // Build a result line that reflects what actually landed. Older
        // structured PDFs return chapters; transcripts and unstructured
        // notes return section topic labels via the rewritten prompt.
        const parts: string[] = [
          `${json.updatedChunks} chunk${json.updatedChunks === 1 ? '' : 's'} tagged`,
        ];
        if (json.chaptersFound > 0) {
          parts.push(
            `${json.chaptersFound} chapter${json.chaptersFound === 1 ? '' : 's'}`,
          );
        }
        const sections = json.sectionsFound ?? 0;
        if (sections > 0) {
          parts.push(`${sections} topic${sections === 1 ? '' : 's'}`);
        }
        toast.success(`Deep-indexed ${filename} · ${parts.join(' · ')}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Deep-index failed');
    } finally {
      setDeepBusy(false);
    }
  };

  const restore = async () => {
    setMenuOpen(false);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/v1/documents/${documentId}/restore`, {
        method: 'POST',
        headers: { ...devHeaders(), 'content-type': 'application/json' },
        body: '{}',
        credentials: 'include',
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        throw new Error(text || `HTTP ${res.status}`);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        aria-label={`Actions for ${filename}`}
        onClick={() => setMenuOpen((o) => !o)}
        disabled={busy}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <span className="block text-base leading-none">⋯</span>
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-7 z-20 min-w-[140px] rounded-md border border-border bg-background shadow-md">
          {trashed ? (
            <button
              type="button"
              onClick={restore}
              className="block w-full px-3 py-2 text-left text-xs hover:bg-accent"
            >
              Restore to Inbox
            </button>
          ) : (
            <>
              {chunkCount > 1 && (
                <button
                  type="button"
                  onClick={runDeepIndex}
                  disabled={deepBusy}
                  className="block w-full px-3 py-2 text-left text-xs hover:bg-accent disabled:opacity-50"
                >
                  {deepBusy ? 'Deep-indexing…' : 'Deep-index (LLM)'}
                </button>
              )}
              <button
                type="button"
                onClick={openDeleteModal}
                className="block w-full px-3 py-2 text-left text-xs text-red-600 hover:bg-accent"
              >
                Delete…
              </button>
            </>
          )}
        </div>
      )}
      {error && !modalOpen && (
        <p className="absolute right-0 top-8 z-10 max-w-xs rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {error}
        </p>
      )}
      {modalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModalOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-xl">
            <h3 className="text-base font-semibold">Move to Trash</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{filename}</span> will be
              moved to Trash. You can restore it from there for 30 days.
            </p>
            {impact === null && !error && (
              <p className="mt-4 text-xs text-muted-foreground">Checking impact…</p>
            )}
            {impact && (
              <ImpactSummary impact={impact} />
            )}
            {error && (
              <p className="mt-4 rounded bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                disabled={busy}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={busy || impact === null || impact.ingestionInFlight}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? 'Deleting…' : 'Move to Trash'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ImpactSummary({ impact }: { impact: ImpactDto }) {
  if (impact.ingestionInFlight) {
    return (
      <div className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Ingestion is still running for this material. Wait until it finishes, then try
        again — deleting now could leave the search index in an inconsistent state.
      </div>
    );
  }
  const c = impact.artifactCounts;
  const total = c.flashcardDecks + c.quizzes + c.roadmaps + c.concepts;
  if (total === 0) {
    return (
      <p className="mt-4 text-xs text-muted-foreground">
        No artifacts have been generated from this folder yet.
      </p>
    );
  }
  const parts: string[] = [];
  if (c.flashcardDecks)
    parts.push(`${c.flashcardDecks} flashcard deck${c.flashcardDecks === 1 ? '' : 's'}`);
  if (c.quizzes) parts.push(`${c.quizzes} quiz${c.quizzes === 1 ? '' : 'zes'}`);
  if (c.roadmaps) parts.push(`${c.roadmaps} roadmap${c.roadmaps === 1 ? '' : 's'}`);
  if (c.concepts) parts.push(`${c.concepts} concept${c.concepts === 1 ? '' : 's'}`);
  return (
    <div className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <p className="font-medium">Heads up — existing artifacts in this folder:</p>
      <p className="mt-1">{parts.join(' · ')}.</p>
      <p className="mt-1">
        Deletion won't remove those artifacts, but future regenerations will exclude
        this material.
      </p>
    </div>
  );
}
