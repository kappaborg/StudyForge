'use client';

import { createContext, useContext } from 'react';

/**
 * Lets the header's hamburger toggle the folders drawer that the shell
 * mounts. We use a context so both pieces stay decoupled (the header
 * doesn't need to know how the sidebar renders, and the sidebar doesn't
 * need to know who triggered it).
 */
export interface MobileNavValue {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

const Noop: MobileNavValue = {
  sidebarOpen: false,
  setSidebarOpen: () => undefined,
  toggleSidebar: () => undefined,
};

export const MobileNavContext = createContext<MobileNavValue>(Noop);

export function useMobileNav(): MobileNavValue {
  return useContext(MobileNavContext);
}
