'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from './auth-gate';

export function UserMenu() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!me) return null;
  const initials = me.email.slice(0, 2).toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="Account menu"
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background text-xs font-medium hover:bg-accent"
      >
        {initials}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-20 min-w-[200px] rounded-md border border-border bg-background p-2 shadow-md">
          <p className="truncate px-2 py-1 text-xs text-muted-foreground">{me.email}</p>
          <button
            type="button"
            onClick={() => void logout()}
            className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
