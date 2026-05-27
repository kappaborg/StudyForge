'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { GoogleSignInButton } from '../../components/google-sign-in-button';
import { authClient } from '../../lib/auth-client';

// When the FE is built for the public deploy, hide the email/password
// form — Google OAuth is the only supported sign-in. Backend still
// accepts email/password (kept for local dev) but the UI doesn't surface
// it. Flip via `NEXT_PUBLIC_AUTH_MODE=production` in Vercel env.
const isProd = process.env['NEXT_PUBLIC_AUTH_MODE'] === 'production';

export default function LoginPage() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get('next') ?? '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authClient.login(email.trim(), password);
      router.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Welcome back. Your folders, decks, and tutor history wait inside.
      </p>
      <div className="mt-6 space-y-3">
        <GoogleSignInButton />
        {oauthError(search.get('error'))}
      </div>
      {!isProd && (
        <div className="my-6 flex items-center gap-3">
          <hr className="flex-1 border-border" />
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            or with email
          </span>
          <hr className="flex-1 border-border" />
        </div>
      )}
      {!isProd && <form className="space-y-4" onSubmit={submit}>
        <label className="block text-sm">
          <span className="text-muted-foreground">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
        {error && (
          <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>}
      {!isProd && (
        <p className="mt-6 text-center text-sm text-muted-foreground">
          New here?{' '}
          <Link href={`/signup?next=${encodeURIComponent(next)}`} className="text-foreground underline">
            Create an account
          </Link>
        </p>
      )}
    </main>
  );
}

/**
 * Translate the OAuth callback's ``?error=`` query into a friendly notice.
 * The OAuth path always bounces back to /login on failure so users see a
 * meaningful message rather than a stack trace.
 */
function oauthError(code: string | null): React.ReactNode {
  if (!code) return null;
  const friendly: Record<string, string> = {
    access_denied: 'You declined Google sign-in. Try again to continue.',
    state_mismatch: 'Sign-in was interrupted. Please try again.',
    invalid_callback: 'Sign-in callback was malformed. Please try again.',
    server_misconfigured: 'Google sign-in is not set up on this server yet.',
  };
  const msg = friendly[code] ?? 'Sign-in failed. Try again, or use email below.';
  return (
    <p className="rounded-md border border-amber-500/30 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      {msg}
    </p>
  );
}
