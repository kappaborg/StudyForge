import Link from 'next/link';
import { AppShellWithSidebar } from '../../components/app-shell-with-sidebar';
import { AuthGate } from '../../components/auth-gate';
import { AxeReporter } from '../../components/axe-reporter';
import { CommandPalette } from '../../components/command-palette';
import { Footer } from '../../components/footer';
import { LocaleSwitcher } from '../../components/locale-switcher';
import { PwaRegistrar } from '../../components/pwa-registrar';
import { SearchTrigger } from '../../components/search-trigger';
import { UserMenu } from '../../components/user-menu';

/**
 * Authenticated app shell. Top nav + side nav.
 *
 * Phase 0: marketing layout. Phase 1 wires the real top nav (search,
 * notifications, user menu) and the side nav (courses list).
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <div className="min-h-screen">
        <header className="border-b border-border">
          <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
            <Link href="/dashboard" className="font-semibold tracking-tight">
              StudyForge
            </Link>
            <div className="flex items-center gap-4 text-sm">
              <SearchTrigger />
              <Link
                href="/dashboard"
                className="text-muted-foreground hover:text-foreground"
              >
                Dashboard
              </Link>
              <Link
                href="/instructor"
                className="text-muted-foreground hover:text-foreground"
              >
                Instructor
              </Link>
              <Link
                href="/settings/byok"
                className="text-muted-foreground hover:text-foreground"
              >
                Settings
              </Link>
              <LocaleSwitcher />
              <UserMenu />
            </div>
          </nav>
        </header>
        <AppShellWithSidebar>{children}</AppShellWithSidebar>
        <Footer />
        <CommandPalette />
        <PwaRegistrar />
        <AxeReporter />
      </div>
    </AuthGate>
  );
}
