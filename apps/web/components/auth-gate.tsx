'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState } from 'react';
import { AUTH_REQUIRED, authClient, type Me } from '../lib/auth-client';
import { deleteUserData } from '../lib/local-models-db';

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  me: null,
  loading: true,
  refresh: async () => undefined,
  logout: async () => undefined,
});

export function useAuth(): AuthCtx {
  return useContext(Ctx);
}

/**
 * Wraps the authenticated app shell. When AUTH_REQUIRED is true and the
 * cookie session can't be resolved, redirects to /login.
 *
 * Renders children optimistically while the /me probe is in flight so the
 * UI doesn't flash blank on every navigation. After the probe lands, an
 * unauthenticated user gets bounced to /login.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(AUTH_REQUIRED);
  const router = useRouter();

  const refresh = async (): Promise<void> => {
    if (!AUTH_REQUIRED) {
      setLoading(false);
      return;
    }
    try {
      const v = await authClient.me();
      setMe(v);
    } catch {
      setMe(null);
      router.replace('/login');
    } finally {
      setLoading(false);
    }
  };

  const logout = async (): Promise<void> => {
    // Wipe the leaving user's IndexedDB rows BEFORE clearing the in-memory
    // ``me`` so we still have a userId to scope the delete. Best-effort —
    // server logout proceeds even if the IDB wipe fails (offline / locked).
    const leavingUserId = me?.userId;
    try {
      await authClient.logout();
    } finally {
      if (leavingUserId) {
        try {
          await deleteUserData(leavingUserId);
        } catch {
          // Non-fatal; the next account is still namespaced and won't see
          // this user's rows even if cleanup didn't complete.
        }
      }
      setMe(null);
      router.replace('/login');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Ctx.Provider value={{ me, loading, refresh, logout }}>{children}</Ctx.Provider>
  );
}
