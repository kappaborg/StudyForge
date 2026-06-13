import { getTranslations } from 'next-intl/server';
import { ByokManager } from '../../../../components/byok-manager';
import { LocalTutor } from '../../../../components/local-tutor';

export default async function ByokSettingsPage() {
  // Server-side translation. The ByokManager + LocalTutor sub-
  // components keep their own English copy for now — those are
  // bigger form-heavy surfaces with state-driven strings ("Saving…",
  // "Key copied", etc.) that need careful per-state translation;
  // tracked under task #22.
  const t = await getTranslations('settings');
  return (
    <section className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('byokTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('byokSubtitle')}</p>
      </div>
      <ByokManager />
      <LocalTutor />
    </section>
  );
}
