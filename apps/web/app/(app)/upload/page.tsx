import { Suspense } from 'react';
import { MaterialsBrowser } from '../../../components/materials-browser';
import { TutorAsk } from '../../../components/tutor-ask';
import { UploadPanel } from '../../../components/upload-panel';

export default function UploadPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Materials</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Drop a file to add it to the library, or search what you've already uploaded.
        </p>
      </header>

      <Suspense fallback={<p className="text-xs text-muted-foreground">Loading…</p>}>
        <UploadPanel />
      </Suspense>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          All materials
        </h2>
        <MaterialsBrowser />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Ask about your materials
        </h2>
        <TutorAsk placeholder="e.g. What is gradient descent?" />
      </section>
    </div>
  );
}
