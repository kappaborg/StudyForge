import type { Metadata, Viewport } from 'next';
import { ThemePrehydrationScript } from '@studyforge/ui';
import { Providers } from '../components/providers';
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
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemePrehydrationScript />
      </head>
      <body className="bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
