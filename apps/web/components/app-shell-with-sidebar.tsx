'use client';

import { useRouter } from 'next/navigation';
import { useMobileNav } from '../lib/mobile-nav';
import { FoldersSidebar } from './folders-sidebar';

/**
 * Authenticated content shell. Two layouts share one render path:
 *
 *  • ≥ 768 px (``md:``): the folder rail sits inline as a 220-px grid
 *    column to the left of the page content. No drawer state matters.
 *  • < 768 px: the rail disappears from the inline grid and re-mounts
 *    as a fixed-position drawer that slides in when the header's
 *    hamburger flips ``sidebarOpen`` true. A backdrop dims the page
 *    and a tap anywhere on it closes the drawer.
 *
 * Both copies pass the same ``onSelect`` so a folder click navigates
 * identically on either layout — the MobileNavProvider auto-closes the
 * drawer on route change so there's no race between the click and the
 * pushState.
 */
export function AppShellWithSidebar({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { sidebarOpen, setSidebarOpen } = useMobileNav();
  const select = (folderId: string) => {
    router.push(`/folders/${folderId}`);
  };

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        {/* Inline rail (md+) — hidden on mobile */}
        <div className="hidden md:block">
          <FoldersSidebar onSelect={select} />
        </div>
        <div className="min-w-0">{children}</div>
      </div>

      {/* Mobile drawer */}
      <div
        className={`fixed inset-0 z-40 md:hidden ${sidebarOpen ? '' : 'pointer-events-none'}`}
        aria-hidden={!sidebarOpen}
      >
        <div
          className={`absolute inset-0 bg-black/40 transition-opacity ${
            sidebarOpen ? 'opacity-100' : 'opacity-0'
          }`}
          onClick={() => setSidebarOpen(false)}
        />
        <aside
          className={`absolute left-0 top-0 h-full w-72 max-w-[85vw] overflow-y-auto border-r border-border bg-background p-3 shadow-xl transition-transform duration-200 ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
          aria-label="Folders"
        >
          <FoldersSidebar onSelect={select} />
        </aside>
      </div>
    </main>
  );
}
