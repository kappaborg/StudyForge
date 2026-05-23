/**
 * TanStack Query client factory. One client per session — wired in
 * `app/providers.tsx`. Default behaviours:
 *   - `staleTime: 30s` (avoids refetch storms on tab focus)
 *   - `gcTime: 5min`
 *   - errors are not swallowed; they bubble to the nearest error boundary
 */

import { QueryClient } from '@tanstack/react-query';

export function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          // ApiError on 4xx is permanent; retrying it is a waste.
          const status = (error as { status?: number }).status;
          if (typeof status === 'number' && status >= 400 && status < 500) {
            return false;
          }
          return failureCount < 2;
        },
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
