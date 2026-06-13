import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { BudgetPill } from '../../../components/budget-pill';
import { DailyPlan } from '../../../components/daily-plan';
import { ExamScopesGrid } from '../../../components/exam-scopes-grid';
import { LocalModelsGrid } from '../../../components/local-models-grid';
import { RecentUploads } from '../../../components/recent-uploads';
import { ReviewWidget } from '../../../components/review-widget';
import { StreakCard } from '../../../components/streak-card';
import { SubscriptionsPanel } from '../../../components/subscriptions-panel';
import { TutorAsk } from '../../../components/tutor-ask';

export default async function DashboardPage() {
  // Server-side translation. The bundles already carry the keys
  // (dashboard.title / subtitle / upload / openWorkspace / askAnything)
  // — wiring just brings the rest of the dashboard surface onto the
  // same i18n pipeline as the nav.
  const t = await getTranslations('dashboard');

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <DailyPlan />

      <section className="grid gap-4 md:grid-cols-3">
        <Link
          href="/upload"
          className="rounded-lg border border-border p-5 hover:bg-accent"
        >
          <h2 className="font-medium">{t('upload')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            PDF, slides, docs, notebooks, audio, and images — up to 1 GB.
            Indexed and ready to ask about within seconds.
          </p>
        </Link>
        <Link
          href="/upload"
          className="rounded-lg border border-border p-5 hover:bg-accent"
        >
          <h2 className="font-medium">{t('openWorkspace')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            One place for your tutor, study roadmap, flashcards, quizzes,
            and concept map — all grounded in your materials.
          </p>
        </Link>
        <BudgetPill />
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <ReviewWidget />
        <StreakCard />
        <Link
          href="/mastery"
          className="rounded-lg border border-border p-5 hover:bg-accent"
        >
          <h2 className="font-medium">Mastery</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Per-concept progress across your folders. Click in to see where
            you're weakest and quiz yourself adaptively.
          </p>
        </Link>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('askAnything')}
        </h2>
        <TutorAsk placeholder="What is gradient descent?" />
      </section>

      <SubscriptionsPanel />

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

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Recently uploaded
          </h2>
          <Link
            href="/upload"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            View all →
          </Link>
        </div>
        <RecentUploads />
      </section>
    </div>
  );
}
