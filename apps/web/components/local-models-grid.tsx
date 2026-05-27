'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { relativeTime } from '../lib/format-document';
import {
  deleteLocalModel,
  listLocalModels,
  type LocalModelRow,
} from '../lib/local-models-client';
import { SkeletonCardGrid } from './skeleton';
import {
  LOCAL_MODEL_CAP_BYTES,
  deleteIndex,
  userBytes,
} from '../lib/local-models-db';
import { useAuth } from './auth-gate';

export function LocalModelsGrid() {
  const { me } = useAuth();
  const [models, setModels] = useState<LocalModelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!me) return;
    try {
      const list = await listLocalModels();
      setModels(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load offline models');
    }
    try {
      // Per-user usage: sum of this account's own meta rows. Avoids the
      // whole-origin estimate that would otherwise leak bytes from other
      // accounts on this browser into the current user's meter.
      setUsage(await userBytes(me.userId));
    } catch {
      // IDB unavailable — skip the meter.
    }
  }, [me]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (m: LocalModelRow) => {
    if (!me) return;
    if (!confirm(`Delete offline tutor for "${m.folderName}"?`)) return;
    try {
      await deleteIndex(me.userId, m.folderId);
      await deleteLocalModel(m.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  if (models === null) {
    return <SkeletonCardGrid count={2} />;
  }

  return (
    <div className="space-y-3">
      {usage !== null && <StorageMeter usage={usage} />}
      {error && (
        <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      )}
      {models.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
          <p>No offline tutors yet.</p>
          <p className="mt-1">
            Open any folder with materials and click <span className="font-medium">Build offline tutor</span> —
            an in-browser RAG index runs entirely on your machine.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {models.map((m) => (
            <ModelCard key={m.id} model={m} onDelete={() => void remove(m)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ModelCard({
  model,
  onDelete,
}: {
  model: LocalModelRow;
  onDelete: () => void;
}) {
  const status = model.status;
  const ready = status === 'ready';
  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{model.folderName}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {status === 'building'
              ? 'Building…'
              : status === 'failed'
                ? 'Build failed'
                : `${model.chunkCount} chunks · ${formatBytes(model.sizeBytes)}`}
          </p>
          {model.builtAt && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Built {relativeTime(model.builtAt)}
              {model.stale && (
                <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                  Stale
                </span>
              )}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${model.folderName}`}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          ✕
        </button>
      </div>
      <div className="mt-3 flex gap-2">
        {ready && (
          <Link
            href={`/local-tutor/${model.folderId}`}
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
          >
            Open
          </Link>
        )}
        <Link
          href={`/folders/${model.folderId}`}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          {ready ? 'Rebuild' : 'Folder'}
        </Link>
      </div>
    </li>
  );
}

function StorageMeter({ usage }: { usage: number }) {
  // Per-account usage summed from our own meta rows (see ``userBytes``).
  // Cap is what we promise on the dashboard, NOT the browser's whole-disk
  // quota — that quota would otherwise look strange ("4 GB? but my disk is
  // 256 GB") and would mix in storage from other accounts on this browser.
  const cap = LOCAL_MODEL_CAP_BYTES;
  const pct = Math.min(100, (usage / cap) * 100);
  const warn = pct > 80;
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">Offline storage</span>
        <span className={warn ? 'text-amber-700' : 'text-muted-foreground'}>
          {formatBytes(usage)} of {formatBytes(cap)}
        </span>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full transition-all ${warn ? 'bg-amber-500' : 'bg-foreground'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {warn && (
        <p className="mt-1 text-[11px] text-amber-700">
          Approaching the offline-storage cap. Delete an old offline tutor to make room.
        </p>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
