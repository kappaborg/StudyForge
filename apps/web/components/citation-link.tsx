'use client';

import { useState } from 'react';
import { CitationPreview, type CitationSource } from './citation-preview';

interface Props {
  ord: number; // 1-based index for the [n] marker
  source: CitationSource;
  label?: string; // optional override (e.g. "filename · p.4")
  compact?: boolean;
}

/**
 * Inline citation chip. Renders the [n] marker or a longer label; click
 * opens the source slide-over (chunk content + neighbors). Works for both
 * cloud and offline (IDB-backed) citations via the ``source.kind`` discriminator.
 */
export function CitationLink({ ord, source, label, compact }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1 rounded ${
          compact ? 'px-1 text-[10px]' : 'px-1.5 py-0.5 text-xs'
        } font-mono text-muted-foreground transition-colors hover:bg-accent hover:text-foreground`}
        title={label ?? `Open citation [${ord}]`}
      >
        <span>[{ord}]</span>
        {label && !compact && <span className="font-sans">{label}</span>}
      </button>
      {open && <CitationPreview source={source} onClose={() => setOpen(false)} />}
    </>
  );
}
