import { AdaptiveQuizButton } from '../../../components/adaptive-quiz-button';
import { MasteryGrid } from '../../../components/mastery-grid';

export default function MasteryPage() {
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mastery</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Per-concept mastery across all your folders. Lower scores rise to
            the top of each section — those are the concepts to focus on next.
          </p>
        </div>
        <AdaptiveQuizButton />
      </header>

      <MasteryGrid />
    </div>
  );
}
