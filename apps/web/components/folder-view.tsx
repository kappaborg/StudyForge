'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, ApiError } from '../lib/dev-fetch';
import { useFolders, type Folder } from '../lib/folders';
import { listLocalModels, type LocalModelRow } from '../lib/local-models-client';
import { DocumentRowActions } from './document-row-actions';
import { ExamScopeModal } from './exam-scope-modal';
import { LocalModelBuilder } from './local-model-builder';

interface Document {
  id: string;
  originalFilename: string;
  mime: string;
  pageCount: number | null;
  chunkCount: number;
  folderId: string | null;
  deletedAt: string | null;
  createdAt: string;
}

/**
 * Per-folder workspace. Lists documents in the folder, surfaces folder
 * metadata, and routes generation actions back through the existing
 * workspace tabs with the folder id baked into the URL so retrieval is
 * scoped correctly.
 */
export function FolderView({ folderId }: { folderId: string }) {
  const { folders, setActiveFolderId } = useFolders();
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localModel, setLocalModel] = useState<LocalModelRow | null>(null);
  const [scopeModalOpen, setScopeModalOpen] = useState(false);

  const folder: Folder | undefined = folders.find((f) => f.id === folderId);

  const refreshLocalModel = useCallback(async () => {
    try {
      const models = await listLocalModels();
      setLocalModel(models.find((m) => m.folderId === folderId) ?? null);
    } catch {
      // non-fatal — the offline-tutor card simply won't render
    }
  }, [folderId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const includeTrash = folder?.kind === 'trash' ? '&includeTrashed=1' : '';
      const res = await apiGet<Document[]>(
        `/v1/documents?folderId=${folderId}&limit=200${includeTrash}`,
      );
      setDocs(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [folderId, folder?.kind]);

  useEffect(() => {
    setActiveFolderId(folderId);
    void load();
    void refreshLocalModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, folder?.kind]);

  const isTrash = folder?.kind === 'trash';
  const isInbox = folder?.kind === 'inbox';

  return (
    <section className="space-y-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {folder ? folder.name : 'Folder'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isTrash
              ? 'Deleted materials are recoverable for 30 days, then permanently removed.'
              : isInbox
                ? 'Materials with no explicit folder land here. Move them to a folder to organize.'
                : 'Materials in this folder feed any generation you run from here.'}
          </p>
        </div>
        {!isTrash && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setScopeModalOpen(true)}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
            >
              Set exam scope
            </button>
            <Link
              href={`/upload?folder=${folderId}`}
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
            >
              Upload here
            </Link>
          </div>
        )}
      </header>

      {scopeModalOpen && (
        <ExamScopeModal
          folderId={folderId}
          folderName={folder?.name ?? 'this folder'}
          onClose={() => setScopeModalOpen(false)}
          onCreated={(id) => {
            setScopeModalOpen(false);
            window.location.href = `/exam-scopes/${id}`;
          }}
        />
      )}

      {!isTrash && (
        <OfflineTutorPanel
          folderId={folderId}
          folderName={folder?.name ?? 'this folder'}
          model={localModel}
          onChanged={() => void refreshLocalModel()}
          docCount={docs.length}
        />
      )}

      {!isTrash && (
        <nav className="flex flex-wrap gap-2">
          <ActionLink href={`/courses/${folderId}/flashcards`} label="Flashcards" />
          <ActionLink href={`/courses/${folderId}/quizzes`} label="Quizzes" />
          <ActionLink href={`/courses/${folderId}/roadmap`} label="Roadmap" />
          <ActionLink href={`/courses/${folderId}/graph`} label="Knowledge graph" />
          <ActionLink href={`/courses/${folderId}/diagrams`} label="Diagrams" />
          <ActionLink href={`/courses/${folderId}/presentations`} label="Slides" />
          <ActionLink href={`/courses/${folderId}/tutor`} label="Tutor" />
        </nav>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Materials ({docs.length})
        </h2>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {loading && docs.length === 0 && (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
        {!loading && docs.length === 0 && !error && (
          <EmptyState kind={folder?.kind ?? 'materials'} folderId={folderId} />
        )}
        {docs.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {docs.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-2 px-4 py-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className={`truncate font-medium ${d.deletedAt ? 'text-muted-foreground line-through' : ''}`}>
                    {d.originalFilename}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {d.mime} · {d.pageCount ?? 0} pages · {d.chunkCount} chunks ·{' '}
                    {new Date(d.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <DocumentRowActions
                  documentId={d.id}
                  filename={d.originalFilename}
                  trashed={d.deletedAt !== null}
                  onChanged={() => {
                    void load();
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function OfflineTutorPanel({
  folderId,
  folderName,
  model,
  docCount,
  onChanged,
}: {
  folderId: string;
  folderName: string;
  model: LocalModelRow | null;
  docCount: number;
  onChanged: () => void;
}) {
  const ready = model?.status === 'ready';
  return (
    <section className="rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Offline tutor</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {ready
              ? model?.stale
                ? 'Your offline tutor is built but new materials have arrived — rebuild to include them.'
                : 'Your offline tutor is ready. Open it to chat without a network.'
              : 'Build a private, offline-capable tutor from the materials in this folder. Runs entirely in your browser.'}
          </p>
        </div>
        {ready && (
          <Link
            href={`/local-tutor/${folderId}`}
            className="rounded-md bg-foreground px-4 py-2 text-xs font-medium text-background hover:opacity-90"
          >
            Open offline tutor
          </Link>
        )}
      </div>
      <div className="mt-3">
        {docCount === 0 ? (
          <p className="text-xs text-muted-foreground">
            Upload at least one document to enable an offline tutor for this folder.
          </p>
        ) : (
          <LocalModelBuilder
            folderId={folderId}
            folderName={folderName}
            onBuilt={onChanged}
            size="compact"
          />
        )}
      </div>
      {ready && model && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {model.chunkCount} chunks indexed · built{' '}
          {model.builtAt ? new Date(model.builtAt).toLocaleString() : 'recently'}
          {model.stale && ' · stale'}
        </p>
      )}
    </section>
  );
}

function ActionLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
    >
      {label}
    </Link>
  );
}

function EmptyState({ kind, folderId }: { kind: Folder['kind']; folderId: string }) {
  if (kind === 'trash') {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
        Trash is empty. Deleted materials land here for 30 days.
      </p>
    );
  }
  return (
    <div className="rounded-md border border-dashed border-border p-6 text-center text-sm">
      <p className="text-muted-foreground">No materials in this folder yet.</p>
      <Link
        href={`/upload?folder=${folderId}`}
        className="mt-2 inline-block text-foreground underline"
      >
        Upload your first one
      </Link>
    </div>
  );
}
