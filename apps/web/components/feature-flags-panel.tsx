'use client';

import { useEffect, useState } from 'react';
import { API_BASE, apiGet, ApiError } from '../lib/dev-fetch';

interface FeatureFlag {
  name: string;
  description: string | null;
  enabled: boolean;
  updatedAt: string;
}

export function FeatureFlagsPanel() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await apiGet<FeatureFlag[]>('/v1/feature-flags');
      setFlags(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load flags');
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const toggle = async (name: string, enabled: boolean) => {
    setBusyName(name);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/v1/feature-flags/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': '11111111-1111-1111-1111-111111111111',
          'x-user-id': '22222222-2222-2222-2222-222222222222',
          'x-user-email': 'dev@studyforge.local',
        },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        throw new Error(detail);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toggle failed');
    } finally {
      setBusyName(null);
    }
  };

  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Feature flags
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Postgres-backed, self-hosted. Toggle experimental code paths without
          a deploy. Changes take effect on the next request.
        </p>
      </header>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {flags.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
          No flags defined yet. Flags are created on first toggle; add a row
          via{' '}
          <code className="rounded bg-muted/40 px-1 py-0.5">
            PATCH /v1/feature-flags/&lt;name&gt;
          </code>
          .
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {flags.map((f) => (
            <li key={f.name} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-sm">{f.name}</div>
                {f.description && (
                  <div className="mt-1 text-xs text-muted-foreground">{f.description}</div>
                )}
                <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  updated {new Date(f.updatedAt).toLocaleString()}
                </div>
              </div>
              <button
                onClick={() => void toggle(f.name, !f.enabled)}
                disabled={busyName === f.name}
                className={`rounded-md px-3 py-1 text-xs font-medium ${
                  f.enabled
                    ? 'bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20'
                    : 'bg-muted text-muted-foreground hover:bg-accent'
                } disabled:opacity-50`}
              >
                {busyName === f.name ? '…' : f.enabled ? 'On' : 'Off'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
