'use client';

import { useRouter } from 'next/navigation';
import { FoldersSidebar } from './folders-sidebar';

/**
 * The authenticated shell's content area, split into a folder rail on the
 * left and the page content on the right. Sidebar clicks navigate to
 * /folders/[id]; the dashboard and individual workspace pages handle that
 * route themselves.
 */
export function AppShellWithSidebar({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <div className="grid gap-6 md:grid-cols-[200px_1fr]">
        <FoldersSidebar
          onSelect={(folderId) => {
            router.push(`/folders/${folderId}`);
          }}
        />
        <div className="min-w-0">{children}</div>
      </div>
    </main>
  );
}
