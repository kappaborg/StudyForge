'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AskAboutSheet } from './ask-about-sheet';
import { QuickFlashcardModal } from './quick-flashcard-modal';

/**
 * Floating chip that appears next to any non-empty text selection inside
 * the app shell. Buttons: Ask · Flashcard · Copy.
 *
 * Why global instead of per-surface? Students select text everywhere —
 * chat answers, citation chunks, document previews, even their own
 * questions. Centralising the chip means every new surface gets the
 * highlight-to-ask affordance for free.
 *
 * The chip suppresses itself inside form fields, modals, and the chip
 * itself (so clicking the chip doesn't cancel the selection).
 */
export function SelectionMenu() {
  const pathname = usePathname();
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
  const [selectedText, setSelectedText] = useState<string>('');
  const [askOpen, setAskOpen] = useState(false);
  const [flashcardOpen, setFlashcardOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Derive a "folder context" from the URL. Used by both Ask (folder-scoped
  // retrieval) and Flashcard (deck title). Best-effort — if the URL doesn't
  // contain a folder id, both flows still work, just without scoping.
  const folderId = pathToFolderId(pathname);

  const recompute = useCallback(() => {
    if (askOpen || flashcardOpen) return; // freeze position while modal open
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!sel || sel.isCollapsed || text.length < 2) {
      setRect(null);
      setSelectedText('');
      return;
    }
    // Skip selections inside form fields and inside the chip itself.
    const node = sel.anchorNode;
    if (!node) return;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el) return;
    if (el.closest('input, textarea, [contenteditable], [data-selection-ignore]')) {
      setRect(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const box = range.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) {
      setRect(null);
      return;
    }
    setRect({
      top: window.scrollY + box.top - 44,
      left: window.scrollX + box.left + box.width / 2,
    });
    setSelectedText(text);
  }, [askOpen, flashcardOpen]);

  useEffect(() => {
    const onSel = () => recompute();
    const onScroll = () => recompute();
    document.addEventListener('selectionchange', onSel);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('selectionchange', onSel);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [recompute]);

  const onCopy = async () => {
    if (!selectedText) return;
    try {
      await navigator.clipboard.writeText(selectedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / iframe context — fall through silently
    }
  };

  return (
    <>
      {rect && selectedText && (
        <div
          data-selection-ignore
          style={{
            position: 'absolute',
            top: rect.top,
            left: rect.left,
            transform: 'translateX(-50%)',
            zIndex: 60,
          }}
          className="flex items-center gap-1 rounded-md border border-border bg-background p-1 shadow-lg"
          // Prevent mousedown from collapsing the selection before the button click fires.
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            onClick={() => setAskOpen(true)}
            className="rounded px-2 py-1 text-xs font-medium hover:bg-accent"
          >
            Ask
          </button>
          <button
            type="button"
            onClick={() => setFlashcardOpen(true)}
            className="rounded px-2 py-1 text-xs font-medium hover:bg-accent"
          >
            Flashcard
          </button>
          <button
            type="button"
            onClick={() => void onCopy()}
            className="rounded px-2 py-1 text-xs font-medium hover:bg-accent"
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      )}

      {askOpen && (
        <AskAboutSheet
          selection={selectedText}
          folderId={folderId}
          onClose={() => setAskOpen(false)}
        />
      )}
      {flashcardOpen && (
        <QuickFlashcardModal
          selection={selectedText}
          folderId={folderId}
          onClose={() => setFlashcardOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Best-effort folder id extraction from the URL. The folder concept lives
 * under three routes today; new routes that should participate just need
 * to surface a folder id in their path.
 */
function pathToFolderId(pathname: string | null): string | null {
  if (!pathname) return null;
  const patterns = [
    /^\/folders\/([0-9a-f-]{36})/i,
    /^\/local-tutor\/([0-9a-f-]{36})/i,
    /^\/courses\/([0-9a-f-]{36})/i,
  ];
  for (const re of patterns) {
    const m = pathname.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}
