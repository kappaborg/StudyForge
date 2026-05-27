'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/**
 * Segment-level error boundary for the authenticated app shell. Catches
 * render-time exceptions in any child route so users see a recovery card
 * instead of Next.js's default uncaught-error screen.
 *
 * ``reset`` re-mounts the segment; useful when the failure was a transient
 * network blip and a retry will succeed without a full page reload.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the browser console so the user can copy/paste it into
    // a bug report. Telemetry pipes are intentionally not invoked from
    // an error boundary to avoid an error storm if the cause is the
    // telemetry client itself.
    // eslint-disable-next-line no-console
    console.error('app.segment.error', error);
  }, [error]);

  return (
    <main className="mx-auto flex max-w-md flex-col items-start gap-4 px-6 py-16">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        Something went wrong
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">
        This page hit an error.
      </h1>
      <p className="text-sm text-muted-foreground">
        It's probably transient — try again, or head back to the dashboard.
        If it sticks around, paste the digest below into the issue tracker.
      </p>
      {error.digest && (
        <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          {error.digest}
        </code>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
