import { TutorAsk } from '../../../../../components/tutor-ask';

/** Always-on tutor pane. Sits in the workspace's parallel slot and runs
 *  retrieval + cited answer against the tenant's materials. */
export default function TutorPane() {
  return (
    <div className="flex h-full flex-col gap-3">
      <header>
        <h2 className="text-sm font-semibold">AI Tutor</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Grounded in your uploaded materials. Refuses if it can&apos;t find a citation.
        </p>
      </header>
      <TutorAsk placeholder="Ask about your materials…" compact />
    </div>
  );
}
