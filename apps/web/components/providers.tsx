'use client';

import { ThemeProvider } from '@studyforge/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { buildQueryClient } from '../lib/query-client';

/**
 * Root providers wired by `app/layout.tsx`. Keep this list intentionally
 * short — providers near the root cost everything below them on every render.
 *
 * i18n is provided one level up by ``NextIntlClientProvider`` in the
 * root layout, so consumers can call ``useTranslations`` here without
 * a separate provider.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(() => buildQueryClient());
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}
