'use client';

import { LOCALES, LOCALE_LABELS, type Locale } from '../lib/i18n';
import { useI18n } from '../lib/i18n';

export function LocaleSwitcher() {
  const { locale } = useI18n();

  return (
    <select
      value={locale}
      onChange={(e) => {
        const next = e.target.value as Locale;
        (window as unknown as { __setLocale?: (l: Locale) => void }).__setLocale?.(next);
      }}
      aria-label="Select language"
      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_LABELS[l]}
        </option>
      ))}
    </select>
  );
}
