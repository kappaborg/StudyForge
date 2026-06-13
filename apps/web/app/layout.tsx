import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ThemePrehydrationScript } from '@studyforge/ui';
import { Providers } from '../components/providers';
import { PwaRegistrar } from '../components/pwa-registrar';
import { directionFor, type Locale } from '../lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'StudyForge AI',
    template: '%s · StudyForge AI',
  },
  description:
    'Upload your course materials. Get a personalized, cited, AI-powered study experience.',
  applicationName: 'StudyForge AI',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'StudyForge',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
  robots: { index: true, follow: true },
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
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
        <PwaRegistrar />
      </body>
    </html>
  );
}
