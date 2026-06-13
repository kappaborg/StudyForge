'use client';

import { setLocaleAction } from '../lib/locale-actions';

interface Props {
  currentLocale: string;
  options: Array<{ value: string; label: string }>;
}

/**
 * Client-side island that owns the ``<select>`` + the auto-submit
 * handler. Lives inside a server-action form so picking a language
 * round-trips to the server, stamps the ``NEXT_LOCALE`` cookie,
 * revalidates the layout, and re-renders translated — all without a
 * full reload.
 */
export function LocaleSelect({ currentLocale, options }: Props): React.ReactElement {
  return (
    <form action={setLocaleAction} className="inline-flex" aria-label="Language selector">
      <select
        name="locale"
        defaultValue={currentLocale}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        aria-label="Select language"
        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </form>
  );
}
