import Link from 'next/link';

export const metadata = {
  title: 'Not found',
};

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-md flex-col items-start gap-4 px-6 py-24">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        404
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">
        We couldn't find that page.
      </h1>
      <p className="text-sm text-muted-foreground">
        The link may be old, or the resource was deleted. Head back to the
        dashboard and pick up from there.
      </p>
      <Link
        href="/dashboard"
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
      >
        Back to dashboard
      </Link>
    </main>
  );
}
