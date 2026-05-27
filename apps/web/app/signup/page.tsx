'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { GoogleSignInButton } from '../../components/google-sign-in-button';
import { track } from '../../lib/analytics';
import { authClient } from '../../lib/auth-client';

// When NEXT_PUBLIC_AUTH_MODE=production, the public deploy is Google-only.
// Hide the email/password form so users always go through OAuth.
const isProd = process.env['NEXT_PUBLIC_AUTH_MODE'] === 'production';

export default function SignupPage() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get('next') ?? '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      const me = await authClient.signup(email.trim(), password);
      track('signup.completed', { userId: me.userId });
      router.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Free, with your own private workspace. Drop in your course materials
        and StudyForge takes it from there.
      </p>
      <div className="mt-6 space-y-3">
        <GoogleSignInButton label="Sign up with Google" />
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
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Confirm password</span>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
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
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>}
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="text-foreground underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
