/**
 * i18n primitives.
 *
 * The translation pipeline itself lives in ``next-intl``: this module
 * only owns the locale registry + the metadata (display label, RTL
 * direction) the rest of the app reaches for.
 *
 * Why not just re-export from ``next-intl``: components that need the
 * locale LIST (the LocaleSwitcher options, the ``<html dir>`` decision
 * in the root layout) want a plain array, not a translation hook.
 */

export const LOCALES = ['en', 'es', 'fr', 'de', 'tr', 'zh', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  tr: 'Türkçe',
  zh: '中文',
  ar: 'العربية',
};

const RTL_LOCALES: readonly Locale[] = ['ar'] as const;

export function directionFor(locale: Locale): 'ltr' | 'rtl' {
  return RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
}

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
  );
}
