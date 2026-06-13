'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useFolders, type Folder } from '../lib/folders';

const KIND_ORDER: Record<Folder['kind'], number> = {
  inbox: 0,
  materials: 1,
  trash: 2,
};

function sortFolders(folders: Folder[]): Folder[] {
  return [...folders].sort((a, b) => {
    const kindDelta = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (kindDelta !== 0) return kindDelta;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Folders sidebar — left rail on the dashboard + workspace shell.
 *
 * Inbox pinned at top, user folders alphabetical, Trash at bottom. Clicking
 * a folder navigates via callback (so the parent owns the route choice).
 * In-place create + rename via the ⋯ menu.
 */
export function FoldersSidebar({
  onSelect,
  activeFolderId,
}: {
  onSelect?: (folderId: string) => void;
  activeFolderId?: string | null;
}) {
  const { folders, activeFolderId: hookActive, setActiveFolderId, loading, error, create, remove } =
    useFolders();
  const tc = useTranslations('common');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const active = activeFolderId ?? hookActive;
  const sorted = sortFolders(folders);

  const onClick = (id: string) => {
    setActiveFolderId(id);
    onSelect?.(id);
  };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || creating) return;
    setCreating(true);
    setLocalError(null);
    try {
      await create(newName.trim());
      setNewName('');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (folder: Folder) => {
    if (folder.kind !== 'materials') return;
    if (folder.documentCount > 0) {
      setLocalError(
        `"${folder.name}" still has ${folder.documentCount} material${folder.documentCount === 1 ? '' : 's'}. Move them out first.`,
      );
      return;
    }
    if (!window.confirm(`Delete folder "${folder.name}"?`)) return;
    setBusyId(folder.id);
    try {
      await remove(folder.id);
      setLocalError(null);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <aside className="space-y-2" aria-label="Folders">
      <header className="px-2">
        <h2 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Folders
        </h2>
      </header>
      {error && <p className="px-2 text-xs text-red-500">{error}</p>}
      {localError && <p className="px-2 text-xs text-red-500">{localError}</p>}
      <ul className="space-y-0.5">
        {loading && folders.length === 0 && (
          <li className="px-2 text-xs text-muted-foreground">{tc('loading')}</li>
        )}
        {sorted.map((folder) => {
          const isActive = active === folder.id;
          const isSystem = folder.kind !== 'materials';
          const label = folder.name;
          return (
            <li key={folder.id} className="group flex items-center gap-1">
              <button
                onClick={() => onClick(folder.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex flex-1 items-center gap-2 truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  isActive
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                }`}
              >
                <FolderIcon kind={folder.kind} />
                {folder.color && folder.kind === 'materials' && (
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: folder.color }}
                  />
                )}
                <span className="flex-1 truncate">{label}</span>
                <span className="text-[10px] text-muted-foreground">{folder.documentCount}</span>
              </button>
              {!isSystem && (
                <button
                  onClick={() => void onDelete(folder)}
                  disabled={busyId === folder.id}
                  className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-rose-500/10 hover:text-rose-600 group-hover:opacity-100"
                  aria-label={`Delete folder ${folder.name}`}
                  title="Delete folder"
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <form onSubmit={onCreate} className="flex gap-1 px-1 pt-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New folder…"
          aria-label="New folder name"
          className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
        />
        <button
          type="submit"
          disabled={!newName.trim() || creating}
          className="rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background hover:opacity-90 disabled:opacity-40"
        >
          +
        </button>
      </form>
    </aside>
  );
}

function FolderIcon({ kind }: { kind: Folder['kind'] }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'flex-shrink-0',
  };
  if (kind === 'inbox') {
    return (
      <svg {...common}>
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
    );
  }
  if (kind === 'trash') {
    return (
      <svg {...common}>
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
