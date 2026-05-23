import { Suspense } from 'react';
import { DocumentsList } from '../../../components/documents-list';
import { TutorAsk } from '../../../components/tutor-ask';
import { UploadPanel } from '../../../components/upload-panel';

export default function UploadPage() {
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
      <div className="space-y-8">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Upload materials</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drop a file below. The pipeline scans, chunks, embeds, and indexes it. Pick a folder
            so the material is grouped with the right lecture set.
          </p>
        </header>

        <Suspense fallback={<p className="text-xs text-muted-foreground">Loading…</p>}>
          <UploadPanel />
        </Suspense>

        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Ask about your materials
          </h2>
          <TutorAsk placeholder="e.g. What is gradient descent?" />
        </section>
      </div>

      <aside className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Recent uploads
        </h2>
        <DocumentsList limit={10} />
      </aside>
    </div>
  );
}
