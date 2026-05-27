'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useFolders } from '../lib/folders';
import { UploadDropZone } from './upload-drop-zone';

/**
 * Wraps the upload drop zone with a folder picker. Reads ``?folder=<id>``
 * from the URL on mount, otherwise defaults to the last-used folder
 * (Inbox on first visit). Selection is local — it doesn't change the
 * route, just the folderId we pass to the upload init.
 */
export function UploadPanel() {
  const searchParams = useSearchParams();
  const { folders, activeFolderId, setActiveFolderId } = useFolders();
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    const queryFolder = searchParams.get('folder');
    if (queryFolder) setActiveFolderId(queryFolder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const uploadable = folders.filter((f) => f.kind !== 'trash');
  const active = uploadable.find((f) => f.id === activeFolderId) ?? uploadable[0];

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border p-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Upload destination
            </div>
            <div className="mt-0.5 truncate font-medium">
              {active?.name ?? 'Inbox'}
              {active?.kind === 'inbox' && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  (default — pick a course folder so flashcards and quizzes stay on-topic)
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => setPickerOpen((s) => !s)}
            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
          >
            {pickerOpen ? 'Close' : 'Change folder'}
          </button>
        </div>
        {pickerOpen && (
          <ul className="mt-3 grid gap-1 sm:grid-cols-2">
            {uploadable.map((f) => (
              <li key={f.id}>
                <button
                  onClick={() => {
                    setActiveFolderId(f.id);
                    setPickerOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-md border px-3 py-1.5 text-left text-xs ${
                    f.id === activeFolderId
                      ? 'border-foreground bg-accent'
                      : 'border-border hover:bg-accent'
                  }`}
                >
                  <span>{f.name}</span>
                  <span className="text-muted-foreground">{f.documentCount}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <UploadDropZone folderId={active?.id ?? null} />
    </div>
  );
}
