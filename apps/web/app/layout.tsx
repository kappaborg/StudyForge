import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ThemePrehydrationScript } from '@studyforge/ui';
import { Footer } from '../components/footer';
import { Providers } from '../components/providers';
import { PwaRegistrar } from '../components/pwa-registrar';
import { directionFor, type Locale } from '../lib/i18n';
import './globals.css';

const SITE_DESCRIPTION =
  'Upload your course materials. Get a personalized, cited, AI-powered study experience.';
const SITE_URL = 'https://study-forge-web.vercel.app';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'StudyForge AI',
    template: '%s · StudyForge AI',
  },
  description: SITE_DESCRIPTION,
  applicationName: 'StudyForge AI',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'StudyForge',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    title: 'StudyForge AI — your course, your tutor, your roadmap',
    description: SITE_DESCRIPTION,
    siteName: 'StudyForge AI',
    url: SITE_URL,
    locale: 'en_US',
    // ``app/opengraph-image.tsx`` auto-generates the 1200×630 PNG
    // Next.js will inject the og:image meta tag automatically when
    // that file is present, but we keep it declared here too so the
    // metadata stays explicit + greppable.
  },
  twitter: {
    card: 'summary_large_image',
    title: 'StudyForge AI — your course, your tutor, your roadmap',
    description: SITE_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
  width: 'device-width',
  initialScale: 1,
  // standalone iOS apps need the safe-area inset so the notch doesn't
  // eat the top of the workspace header.
  viewportFit: 'cover',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Resolve locale + messages on the server so the very first paint is
  // already translated. ``getLocale`` walks the next-intl request
  // config which reads the cookie set by ``setLocaleAction``.
  const locale = (await getLocale()) as Locale;
  const messages = await getMessages();
  const dir = directionFor(locale);

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <head>
        <ThemePrehydrationScript />
      </head>
      <body className="bg-background text-foreground antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>
            <div className="flex min-h-screen flex-col">
              <div className="flex-1">{children}</div>
              {/* Mounted at the root so unauthenticated visitors (landing,
                  login, signup, /privacy, /terms, /about) see the same
                  Privacy + Terms links App Store / Play reviewers will
                  look for. The (app) shell deliberately doesn't mount
                  its own Footer anymore to avoid a duplicate. */}
              <Footer />
            </div>
          </Providers>
        </NextIntlClientProvider>
        <PwaRegistrar />
      </body>
    </html>
  );
}
