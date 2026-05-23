'use client';

import { useEffect, useState } from 'react';
import { I18nProviderContext, LOCALES, RTL_LOCALES, translate, type Locale } from '../lib/i18n';

const COOKIE = 'sf-locale';

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const Context = I18nProviderContext();
  const [locale, setLocale] = useState<Locale>('en');

  useEffect(() => {
    const stored = readCookie(COOKIE);
    const detected = stored && (LOCALES as readonly string[]).includes(stored)
      ? (stored as Locale)
      : detectFromNavigator();
    setLocale(detected);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
    document.cookie = `${COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
  }, [locale]);

  // Expose a global setter so the LocaleSwitcher can update without prop
  // drilling. The setter signature is stable.
  useEffect(() => {
    (window as unknown as { __setLocale?: (l: Locale) => void }).__setLocale = (l) => setLocale(l);
    return () => {
      delete (window as unknown as { __setLocale?: (l: Locale) => void }).__setLocale;
    };
  }, []);

  return (
    <Context.Provider value={{ locale, t: (key) => translate(locale, key) }}>
      {children}
    </Context.Provider>
  );
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.split('=')[1];
}

function detectFromNavigator(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  const pref = (navigator.languages ?? [navigator.language ?? 'en']).map((l) => l.toLowerCase());
  for (const candidate of pref) {
    const short = candidate.split('-')[0] as Locale;
    if ((LOCALES as readonly string[]).includes(short)) return short;
  }
  return 'en';
}
