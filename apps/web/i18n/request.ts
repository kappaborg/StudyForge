import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../lib/i18n';

/**
 * next-intl per-request config.
 *
 * Resolves the active locale from the ``NEXT_LOCALE`` cookie. We don't
 * use path-prefix routing (the §10 ``Phase 4`` deliverable is "switch
 * without a full reload" — a cookie-only approach keeps every URL
 * locale-agnostic and lets a logged-in user's locale ride with their
 * session). Falls back to ``DEFAULT_LOCALE`` when the cookie is unset
 * or holds an unknown value.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const raw = cookieStore.get('NEXT_LOCALE')?.value;
  const locale: Locale =
    raw && (LOCALES as readonly string[]).includes(raw) ? (raw as Locale) : DEFAULT_LOCALE;

  // Static import + per-locale chunk: Next compiles each into its own
  // file and only ships the active one to the client. ``await import``
  // on a templated path gives us that codegen for free.
  const messages = (await import(`../messages/${locale}.json`)).default;

  return { locale, messages };
});
