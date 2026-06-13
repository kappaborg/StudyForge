'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiGet, ApiError } from '../lib/dev-fetch';

interface BudgetSnapshot {
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
  monthlyLimit: number;
  monthlyUsed: number;
  dayResetAt: string;
  byok: boolean;
}

export function BudgetPill() {
  const [snap, setSnap] = useState<BudgetSnapshot | null>(null);
  const [error, setError] = useState(false);
  const t = useTranslations('budget');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiGet<BudgetSnapshot>('/v1/me/budget');
        if (!cancelled) setSnap(res);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError);
      }
    };
    void load();
    // Refresh every 60s so a freshly-generated artifact updates the pill.
    const interval = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  if (error || !snap) return null;

  if (snap.byok) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
        <div className="flex items-baseline justify-between">
          <div className="text-[10px] uppercase tracking-wider text-emerald-700">
            {t('unlimited')}
          </div>
        </div>
        <div className="mt-1 text-xl font-semibold">∞ AI requests today</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Your own provider key is in use. Platform daily caps don't apply.
        </div>
      </div>
    );
  }

  const pct = Math.min(1, snap.dailyUsed / Math.max(snap.dailyLimit, 1));
  const tier =
    pct < 0.5 ? 'bg-emerald-500' : pct < 0.85 ? 'bg-amber-500' : 'bg-rose-500';

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t('dailyRequests')}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {t('resets')}{' '}
          {new Date(snap.dayResetAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
      </div>
      <div className="mt-1 text-xl font-semibold">
        {snap.dailyUsed} / {snap.dailyLimit}
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${tier} transition-all`} style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
      {snap.dailyRemaining === 0 ? (
        <div className="mt-2 text-xs text-rose-700">{t('capReached')}</div>
      ) : (
        <div className="mt-2 text-xs text-muted-foreground">
          {snap.dailyRemaining} left today · {t('alwaysFree')}
        </div>
      )}
    </div>
  );
}
