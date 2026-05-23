import Link from 'next/link';
import { BudgetPill } from '../../../components/budget-pill';
import { DocumentsList } from '../../../components/documents-list';
import { ExamScopesGrid } from '../../../components/exam-scopes-grid';
import { LocalModelsGrid } from '../../../components/local-models-grid';
import { NotificationsInbox } from '../../../components/notifications-inbox';
import { TutorAsk } from '../../../components/tutor-ask';

export default function DashboardPage() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Drop materials, ask questions, and pick up where you left off.
        </p>
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        <Link
          href="/upload"
          className="rounded-lg border border-border p-5 hover:bg-accent"
        >
          <h2 className="font-medium">Upload materials</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            PDF · PPTX · DOCX · IPYNB · TXT · MD · JSON · ≤ 1 GB · scanned + chunked + indexed.
          </p>
        </Link>
        <Link
          href="/courses/demo"
          className="rounded-lg border border-border p-5 hover:bg-accent"
        >
          <h2 className="font-medium">Open workspace</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Materials · Tutor · Roadmap · Flashcards · Quizzes · Graph.
          </p>
        </Link>
        <BudgetPill />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Ask anything about your materials
        </h2>
        <TutorAsk placeholder="What is gradient descent?" />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Exam scopes
        </h2>
        <p className="text-xs text-muted-foreground">
          Paste a professor's exam scope inside any folder ("Set exam scope" in
          FolderView). Each scope spins up a focused tutor with retrieval and
          prompting locked to the right chapters and mode.
        </p>
        <ExamScopesGrid />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Offline tutors
        </h2>
        <p className="text-xs text-muted-foreground">
          Per-folder offline tutors live entirely in your browser. The chunks
          and embeddings are stored locally; nothing leaves your machine after
          they're built.
        </p>
        <LocalModelsGrid />
      </section>

      <div className="grid gap-8 md:grid-cols-[1fr_360px]">
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Your materials
          </h2>
          <DocumentsList />
        </section>
        <NotificationsInbox />
      </div>
    </div>
  );
}
