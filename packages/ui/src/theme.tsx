'use client';

import * as React from 'react';

/**
 * Theme provider with light / dark / system support.
 *
 *   - Reads initial theme from the `data-theme` attribute on <html> (set by
 *     the pre-hydration script in app/layout.tsx) so SSR matches CSR exactly.
 *   - Persists explicit choices to localStorage; "system" follows
 *     prefers-color-scheme without writing.
 *   - Exposes the current resolved theme (always "light" or "dark") via
 *     `useTheme`, plus a setter.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'studyforge:theme';
const ATTR = 'data-theme';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = React.useState<ThemePreference>(() =>
    readInitialPreference(),
  );
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>(() => readSystem());

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent): void => {
      setSystemTheme(e.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, []);

  const resolved: ResolvedTheme = preference === 'system' ? systemTheme : preference;

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute(ATTR, resolved);
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  const setPreference = React.useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    if (typeof window === 'undefined') return;
    if (next === 'system') {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (ctx === undefined) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}

/**
 * Returns the pre-hydration script tag that paints the correct theme before
 * React mounts — avoids the dark-flash on first paint. Insert in <head>.
 */
export function ThemePrehydrationScript(): React.ReactElement {
  const code = `(()=>{try{var t=localStorage.getItem('${STORAGE_KEY}');var s=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';var r=(t==='light'||t==='dark')?t:s;document.documentElement.setAttribute('${ATTR}',r);if(r==='dark'){document.documentElement.classList.add('dark')}}catch(e){}})()`;
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}

function readInitialPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return 'system';
}

function readSystem(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
