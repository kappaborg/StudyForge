// Server component — reads the active locale on the server, renders a
// form whose submit invokes a server action to persist + revalidate.
import { getLocale } from 'next-intl/server';
import { LOCALES, LOCALE_LABELS, type Locale } from '../lib/i18n';
import { LocaleSelect } from './locale-select-client';

/**
 * Server-rendered locale switcher. The actual ``<select>`` lives in a
 * tiny client island so it can post the parent form on change without
 * a separate Apply button — server actions work fine inside client
 * components but the auto-submit needs ``form.requestSubmit()`` which
 * is a client-only API.
 */
export async function LocaleSwitcher() {
  const locale = (await getLocale()) as Locale;
  return (
    <LocaleSelect
      currentLocale={locale}
      options={LOCALES.map((l) => ({ value: l, label: LOCALE_LABELS[l] }))}
    />
  );
}
