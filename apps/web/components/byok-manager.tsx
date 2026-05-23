'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost, API_BASE, ApiError } from '../lib/dev-fetch';

interface ByokKey {
  id: string;
  provider: string;
  last4: string;
  label: string | null;
  createdAt: string;
  validatedAt: string | null;
  revokedAt: string | null;
}

const PROVIDERS = ['groq', 'openai', 'anthropic', 'google', 'openrouter'] as const;
type Provider = (typeof PROVIDERS)[number];

const PROVIDER_LABEL: Record<Provider, string> = {
  groq: 'Groq',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  openrouter: 'OpenRouter',
};

export function ByokManager() {
  const [keys, setKeys] = useState<ByokKey[]>([]);
  const [provider, setProvider] = useState<Provider>('groq');
  const [keyText, setKeyText] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await apiGet<ByokKey[]>('/v1/me/byok');
      setKeys(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load keys');
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const add = async () => {
    if (keyText.trim().length < 16) {
      setError('Provider keys are at least 16 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost<ByokKey>('/v1/me/byok', {
        provider,
        key: keyText.trim(),
        label: label.trim() || undefined,
      });
      setKeyText('');
      setLabel('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add key');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      // Use a raw fetch because apiPost is JSON-body only; revoke is DELETE.
      const res = await fetch(`${API_BASE}/v1/me/byok/${id}`, {
        method: 'DELETE',
        headers: {
          'x-tenant-id': '11111111-1111-1111-1111-111111111111',
          'x-user-id': '22222222-2222-2222-2222-222222222222',
          'x-user-email': 'dev@studyforge.local',
          'idempotency-key': `revoke-${id}-${Date.now()}`,
        },
      });
      if (!res.ok && res.status !== 204) {
        const detail = (await res.text()).slice(0, 200);
        throw new Error(detail);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke key');
    } finally {
      setBusy(false);
    }
  };

  const active = keys.filter((k) => !k.revokedAt);

  return (
    <section className="rounded-lg border border-border p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold">BYOK keys</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Plug in your own provider API key — unlocks unlimited AI requests
          on this account. Keys are envelope-encrypted (AES-256-GCM with a
          per-tenant DEK) before they touch the database. Only the last four
          characters are ever shown.
        </p>
      </div>

      <div className="space-y-2 rounded-md border border-dashed border-border p-3">
        <div className="grid gap-2 md:grid-cols-[150px_1fr]">
          <div>
            <label className="text-xs text-muted-foreground">Provider</label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Label (optional)</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="personal"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">API key</label>
          <input
            type="password"
            value={keyText}
            onChange={(e) => setKeyText(e.target.value)}
            placeholder="gsk_… / sk-…"
            autoComplete="off"
            spellCheck={false}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
          />
        </div>
        <button
          onClick={() => void add()}
          disabled={busy || keyText.trim().length < 16}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add key'}
        </button>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      {active.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          No keys yet. Without a key you're on the free platform pool (50 AI
          requests/day). Add a provider key for unlimited use.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {active.map((k) => (
            <li key={k.id} className="flex items-baseline justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <div className="font-medium">
                  {PROVIDER_LABEL[k.provider as Provider] ?? k.provider}
                  {k.label && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      ({k.label})
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  …{k.last4} · added {new Date(k.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button
                onClick={() => void revoke(k.id)}
                disabled={busy}
                className="rounded-md border border-rose-500/30 px-3 py-1 text-xs text-rose-700 hover:bg-rose-500/10 disabled:opacity-50"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
