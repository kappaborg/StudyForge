'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { MobileNavContext } from '../lib/mobile-nav';

/**
 * Wraps the authenticated shell so the header's hamburger and the
 * folder drawer share one piece of state. Closes the drawer on route
 * change so a click in the sidebar doesn't leave it open over the
 * destination page.
 */
export function MobileNavProvider({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  // Restore body scroll when the drawer closes. We lock it open so the
  // background page doesn't scroll under the overlay.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = sidebarOpen ? 'hidden' : prev;
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sidebarOpen]);

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  const value = useMemo(
    () => ({ sidebarOpen, setSidebarOpen, toggleSidebar }),
    [sidebarOpen, toggleSidebar],
  );

  return <MobileNavContext.Provider value={value}>{children}</MobileNavContext.Provider>;
}
