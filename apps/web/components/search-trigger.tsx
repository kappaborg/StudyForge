'use client';

export function SearchTrigger() {
  const open = () => {
    // The palette listens for cmd/ctrl+k globally — dispatch a synthetic
    // keydown so this trigger and the hotkey share one toggle path.
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
    );
  };
  return (
    <button
      onClick={open}
      className="hidden items-center gap-2 rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-accent sm:inline-flex"
      aria-label="Open search palette"
    >
      <span>Search</span>
      <kbd className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono">⌘K</kbd>
    </button>
  );
}
