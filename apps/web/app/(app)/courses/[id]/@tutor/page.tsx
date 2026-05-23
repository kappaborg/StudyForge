import { TutorAsk } from '../../../../../components/tutor-ask';

export default function TutorExpanded() {
  return (
    <div className="flex h-full flex-col gap-3">
      <header>
        <h2 className="text-sm font-semibold">AI Tutor</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Grounded in your uploaded materials.
        </p>
      </header>
      <TutorAsk placeholder="Ask about your materials…" compact />
    </div>
  );
}
