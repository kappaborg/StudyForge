import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-24">
      <p className="text-sm uppercase tracking-widest text-muted-foreground">
        StudyForge AI · v0.1
      </p>
      <h1 className="mt-3 text-5xl font-semibold tracking-tight">
        Your course. Your tutor. Your roadmap.
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
        Upload lectures, slides, notebooks, and code. StudyForge analyses them, builds a
        knowledge graph, and gives you a personalised, cited study experience — free for
        students.
      </p>
      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/signup"
          className="rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background"
        >
          Get started
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-border px-5 py-2.5 text-sm font-medium"
        >
          Sign in
        </Link>
        <Link
          href="/dashboard"
          className="rounded-md border border-dashed border-border px-5 py-2.5 text-sm font-medium text-muted-foreground"
        >
          Open dashboard
        </Link>
      </div>
    </main>
  );
}
