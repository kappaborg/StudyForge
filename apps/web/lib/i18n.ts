'use client';

import { createContext, useContext } from 'react';
import en from '../messages/en.json';
import es from '../messages/es.json';
import fr from '../messages/fr.json';
import de from '../messages/de.json';
import tr from '../messages/tr.json';
import zh from '../messages/zh.json';
import ar from '../messages/ar.json';

export const LOCALES = ['en', 'es', 'fr', 'de', 'tr', 'zh', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  tr: 'Türkçe',
  zh: '中文',
  ar: 'العربية',
};

export const RTL_LOCALES: Locale[] = ['ar'];

const messages: Record<Locale, Record<string, unknown>> = {
  en, es, fr, de, tr, zh, ar,
};

interface I18n {
  locale: Locale;
  t: (key: string) => string;
}

const I18nContext = createContext<I18n>({
  locale: 'en',
  t: (key) => key,
});

export function useI18n(): I18n {
  return useContext(I18nContext);
}

export function I18nProviderContext(): typeof I18nContext {
  return I18nContext;
}

/** Lookup ``a.b.c`` against the active locale, with a fallback to English. */
export function translate(locale: Locale, key: string): string {
  const parts = key.split('.');
  const dive = (obj: unknown): unknown =>
    parts.reduce<unknown>(
      (acc, p) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[p] : undefined),
      obj,
    );
  const out = dive(messages[locale]) ?? dive(messages.en);
  return typeof out === 'string' ? out : key;
}
