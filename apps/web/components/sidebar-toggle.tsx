'use client';

import { useMobileNav } from '../lib/mobile-nav';

/**
 * Hamburger button rendered on mobile only (``md:hidden``). Toggles the
 * folder drawer via the MobileNavContext. The button itself is exactly
 * 44×44px so it meets the WCAG AAA touch-target guidance — anything
 * smaller is consistently mis-tapped on phones.
 */
export function SidebarToggle() {
  const { sidebarOpen, toggleSidebar } = useMobileNav();
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label={sidebarOpen ? 'Close folders' : 'Open folders'}
      aria-expanded={sidebarOpen}
      className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-accent md:hidden"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {sidebarOpen ? (
          <>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </>
        ) : (
          <>
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </>
        )}
      </svg>
    </button>
  );
}
