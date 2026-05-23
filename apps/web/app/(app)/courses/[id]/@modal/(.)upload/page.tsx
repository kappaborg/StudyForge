'use client';

import Link from 'next/link';

/**
 * Intercepting route: navigating from the workspace to `/upload` shows this
 * overlay instead of leaving the course. Direct navigation to `/upload` still
 * resolves to the full-page route.
 */
export default function UploadModal() {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-modal-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-foreground/40 p-6"
    >
      <div className="w-full max-w-2xl rounded-lg border border-border bg-background p-6 shadow-lg">
        <div className="flex items-center justify-between">
          <h2 id="upload-modal-title" className="text-lg font-semibold">
            Upload materials
          </h2>
          <Link
            href="../"
            className="text-sm text-muted-foreground hover:text-foreground"
            aria-label="Close upload modal"
          >
            Close
          </Link>
        </div>
        <div className="mt-4 rounded-md border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          [Phase 1] drop-zone (intercepted from /upload)
        </div>
      </div>
    </div>
  );
}
