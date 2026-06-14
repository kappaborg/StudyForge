import Link from 'next/link';

export const metadata = {
  title: 'Privacy',
  description:
    'How StudyForge handles your data — what we collect, what we don\'t, and how to delete it.',
};

export default function PrivacyPage() {
  return (
    <main className="prose prose-neutral mx-auto max-w-2xl px-6 py-12 dark:prose-invert">
      <h1>Privacy Policy</h1>
      <p className="text-sm text-muted-foreground">Last updated: 2026-06-13</p>

      <p>
        StudyForge ("we", "us") is an AI-powered learning workspace. This page
        explains exactly what data we collect, why, who else touches it, and
        how you can take it back.
      </p>

      <h2>1. What we collect</h2>
      <ul>
        <li>
          <strong>Account info</strong> — email address and display name from
          your Google account when you sign in. We don't see your Google
          password.
        </li>
        <li>
          <strong>Materials you upload</strong> — PDF / text / image / audio
          you drop into the workspace, the text we extract from them, and the
          embedding vectors we compute for retrieval.
        </li>
        <li>
          <strong>Learning activity</strong> — questions you ask the tutor,
          flashcard grades, quiz answers, mastery scores, and roadmap
          progress. This is what makes spaced repetition and the knowledge
          graph work for you.
        </li>
        <li>
          <strong>Operational telemetry</strong> — IP address, browser type,
          timestamps, and error reports. Used for abuse detection,
          rate-limiting, and fixing crashes. We don't link this to ad
          identifiers.
        </li>
      </ul>

      <h2>2. What we don't collect</h2>
      <ul>
        <li>No targeted advertising identifiers (IDFA, GAID).</li>
        <li>No browsing history outside StudyForge.</li>
        <li>No payment info — StudyForge is free.</li>
        <li>No third-party trackers that follow you across other sites.</li>
      </ul>

      <h2>3. Who else touches your data</h2>
      <p>
        We use a small set of third-party providers to run the service. Each
        is named below with what it sees:
      </p>
      <ul>
        <li>
          <strong>Google (OAuth sign-in)</strong> — receives the sign-in
          request; returns your email + name. Governed by{' '}
          <a
            href="https://policies.google.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
          >
            Google's Privacy Policy
          </a>
          .
        </li>
        <li>
          <strong>Cloudflare R2</strong> — stores your uploaded files at rest.
          Files are private to your account.
        </li>
        <li>
          <strong>Neon (Postgres)</strong> — stores your account, materials
          metadata, and learning activity.
        </li>
        <li>
          <strong>Upstash (Redis)</strong> — short-lived session + rate-limit
          state.
        </li>
        <li>
          <strong>LLM providers</strong> — Groq, Google Gemini, OpenRouter,
          Cerebras, Together, Fireworks, HuggingFace, OpenAI, or Anthropic,
          depending on which is healthy. Your tutor query + retrieved passages
          are sent to one provider per request. Cached responses skip the
          provider call entirely.
        </li>
        <li>
          <strong>Resend</strong> — sends transactional email (account
          notifications). It sees your email address and the message body.
        </li>
        <li>
          <strong>Vercel + Render</strong> — host the web and API. Standard
          access logs.
        </li>
        <li>
          <strong>Sentry (optional)</strong> — receives error stack traces
          when enabled. Scrubbed of obvious PII (emails, tokens) before
          send.
        </li>
      </ul>

      <h2>4. BYOK (Bring-Your-Own-Key) mode</h2>
      <p>
        If you add your own LLM provider key in Settings, StudyForge sends
        your queries directly to that provider using your key. We don't
        store the body of those calls and we don't aggregate them against
        your account quota. The provider's own privacy policy applies to
        what they do with the request.
      </p>

      <h2>5. How long we keep it</h2>
      <p>
        We keep your data for as long as your account is active. When you
        delete your account, we remove all materials, learning activity, and
        embeddings within 30 days. Backups roll off within 90 days.
      </p>

      <h2>6. Your rights</h2>
      <p>
        Email{' '}
        <a href="mailto:kayrayilmazedu203@gmail.com">
          kayrayilmazedu203@gmail.com
        </a>{' '}
        to:
      </p>
      <ul>
        <li>Get a copy of everything we have on you (data export).</li>
        <li>Correct anything that's wrong.</li>
        <li>Delete your account and the data attached to it.</li>
        <li>Withdraw consent for processing (we delete the account).</li>
      </ul>
      <p>
        We respond within 30 days. If you're in the EU, UK, or California,
        these are GDPR / UK GDPR / CCPA rights and you can also complain to
        your local data-protection authority.
      </p>

      <h2>7. Children</h2>
      <p>
        StudyForge isn't directed at children under 13 (under 16 in the EU).
        If you believe a child has signed up, email us and we'll remove the
        account.
      </p>

      <h2>8. Changes</h2>
      <p>
        We'll update this page when the data practices change and post the
        new "Last updated" date at the top. Material changes will also be
        announced in-product.
      </p>

      <h2>9. Contact</h2>
      <p>
        <a href="mailto:kayrayilmazedu203@gmail.com">
          kayrayilmazedu203@gmail.com
        </a>{' '}
        for anything in this policy.
      </p>

      <hr />
      <p className="text-xs text-muted-foreground">
        See also: <Link href="/terms">Terms of Service</Link> ·{' '}
        <Link href="/about">About</Link>
      </p>
    </main>
  );
}
