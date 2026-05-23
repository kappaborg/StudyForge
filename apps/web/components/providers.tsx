'use client';

import { ThemeProvider } from '@studyforge/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { buildQueryClient } from '../lib/query-client';
import { I18nProvider } from './i18n-provider';

/**
 * Root providers wired by `app/layout.tsx`. Keep this list intentionally
 * short — providers near the root cost everything below them on every render.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(() => buildQueryClient());
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <I18nProvider>{children}</I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
