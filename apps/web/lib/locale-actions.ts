'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { isLocale } from './i18n';

/**
 * Persist the selected locale + invalidate the route cache so the
 * server re-renders with the new messages on the next visit. We don't
 * call ``redirect`` here — the LocaleSwitcher form posts via JS and
 * the page re-renders inline via ``revalidatePath('/')``.
 *
 * Cookie maxAge: 1 year. Path ``/`` so every route picks it up.
 * SameSite=lax is fine: the cookie is purely for personalization;
 * we don't authenticate off it.
 */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const raw = formData.get('locale');
  if (!isLocale(raw)) return;
  const cookieStore = await cookies();
  cookieStore.set('NEXT_LOCALE', raw, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  // Revalidate from the root so every nested route picks up the new
  // locale on the next render — not just the page we were on.
  revalidatePath('/', 'layout');
}
