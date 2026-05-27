'use client';

import * as React from 'react';

/**
 * Skeleton primitives — shimmering grey placeholders that mirror the
 * shape of content that's about to land. Replaces ad-hoc "Loading…"
 * text across the app for a more polished loading state.
 *
 * ``animate-pulse`` is Tailwind's built-in opacity oscillation. We use
 * ``bg-muted`` so the colour follows the theme; the placeholder reads
 * as background, not as a real UI element.
 *
 * Containers carry ``aria-busy="true"`` and an ``aria-label`` so screen
 * readers announce that loading is in progress rather than parroting an
 * empty skeleton list.
 */

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export function Skeleton({ className = '', ...rest }: DivProps) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded bg-muted ${className}`}
      {...rest}
    />
  );
}

/**
 * One placeholder row that matches the shape of a document row in the
 * various materials lists: file-type pill, title + meta lines, trailing
 * timestamp.
 */
export function SkeletonDocRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Skeleton className="h-8 w-10 flex-shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-2 w-1/3" />
      </div>
      <Skeleton className="h-2 w-12 flex-shrink-0" />
    </div>
  );
}

export function SkeletonDocList({ rows = 5 }: { rows?: number }) {
  return (
    <ul
      role="status"
      aria-busy="true"
      aria-label="Loading materials"
      className="divide-y divide-border rounded-md border border-border"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i}>
          <SkeletonDocRow />
        </li>
      ))}
    </ul>
  );
}

/**
 * Card placeholder for grids — exam scopes, offline tutors, mastery
 * tiles. Roughly matches a card with title + subtitle + a row of chips.
 */
export function SkeletonCard() {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
      <div className="flex gap-2">
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-3 w-14" />
      </div>
    </div>
  );
}

export function SkeletonCardGrid({
  count = 4,
  className = 'grid gap-3 md:grid-cols-2',
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className={className}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
