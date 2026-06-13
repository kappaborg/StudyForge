import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * Quiet footer linking to the project's public surfaces. No paywall, no
 * email collection — just the always-free positioning we want users to
 * trust on first visit.
 *
 * Server-translated: ``StudyForge`` and ``GitHub`` stay literal (brand
 * + linked service name); tagline + ``About`` link flip with the
 * active locale.
 */
export async function Footer() {
  const t = await getTranslations('footer');
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-4 text-xs text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">StudyForge</span> ·{' '}
          {t('tagline')}
        </div>
        <nav className="flex flex-wrap gap-4" aria-label="Footer">
          <Link href="/about" className="hover:text-foreground">
            {t('about')}
          </Link>
          <a
            href="https://github.com/kappaborg"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground"
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
