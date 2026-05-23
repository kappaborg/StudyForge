import { ByokManager } from '../../../../components/byok-manager';
import { LocalTutor } from '../../../../components/local-tutor';

export default function ByokSettingsPage() {
  return (
    <section className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Keys &amp; Local AI</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          StudyForge is always free. Add a BYOK provider key for unlimited AI
          requests, or skip cloud entirely with the browser-local model.
        </p>
      </div>
      <ByokManager />
      <LocalTutor />
    </section>
  );
}
