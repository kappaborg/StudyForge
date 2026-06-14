import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AppShellWithSidebar } from '../../components/app-shell-with-sidebar';
import { AuthGate } from '../../components/auth-gate';
import { AxeReporter } from '../../components/axe-reporter';
import { CommandPalette } from '../../components/command-palette';
import { LocaleSwitcher } from '../../components/locale-switcher';
import { MobileNavProvider } from '../../components/mobile-nav-provider';
import { NotificationsBell } from '../../components/notifications-bell';
import { SearchTrigger } from '../../components/search-trigger';
import { SelectionMenu } from '../../components/selection-menu';
import { SidebarToggle } from '../../components/sidebar-toggle';
import { StreakPill } from '../../components/streak-pill';
import { ToastProvider } from '../../components/toast';
import { UserMenu } from '../../components/user-menu';

/**
 * Authenticated app shell. Mobile-first responsive top nav:
 *
 *   • < 768 px: hamburger (folders drawer) + logo + user menu in the top
 *     bar; primary links collapse into a horizontal-scroll strip below
 *     so a phone keyboard never hides them.
 *   • ≥ 768 px: classic single-row top bar with all links inline.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = await getTranslations('nav');
  // Single source of truth for the nav so desktop + mobile rows can't
  // drift. Translations are resolved on the server with the user's
  // active locale.
  const navItems = [
    { href: '/dashboard', label: t('dashboard') },
    { href: '/review', label: t('review') },
    { href: '/mastery', label: t('mastery') },
    { href: '/instructor', label: t('instructor') },
    { href: '/settings/byok', label: t('settings') },
  ];

  return (
    <AuthGate>
      <ToastProvider>
        <MobileNavProvider>
          <div className="min-h-screen">
            <header className="border-b border-border">
              <nav className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-3 py-2 sm:px-6 sm:py-3">
                <div className="flex items-center gap-1 sm:gap-3">
                  <SidebarToggle />
                  <Link
                    href="/dashboard"
                    className="text-base font-semibold tracking-tight"
                  >
                    StudyForge
                  </Link>
                </div>
                <div className="hidden items-center gap-4 text-sm md:flex">
                  <SearchTrigger />
                  {navItems.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {item.label}
                    </Link>
                  ))}
                  <StreakPill />
                  <NotificationsBell />
                  <LocaleSwitcher />
                  <UserMenu />
                </div>
                <div className="flex items-center gap-1 md:hidden">
                  <StreakPill />
                  <NotificationsBell />
                  <UserMenu />
                </div>
              </nav>
              {/* Mobile sub-nav — horizontal scroll keeps every primary
                  link reachable on a small screen without a menu drawer. */}
              <div className="md:hidden">
                <ul className="flex gap-1 overflow-x-auto px-3 pb-2 text-sm">
                  {navItems.map((item) => (
                    <li key={item.href} className="flex-shrink-0">
                      <Link
                        href={item.href}
                        className="block whitespace-nowrap rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </header>
            <AppShellWithSidebar>{children}</AppShellWithSidebar>
            <CommandPalette />
            <SelectionMenu />
            <AxeReporter />
          </div>
        </MobileNavProvider>
      </ToastProvider>
    </AuthGate>
  );
}
