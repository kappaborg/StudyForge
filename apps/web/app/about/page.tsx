import Link from 'next/link';

export const metadata = {
  title: 'About',
  description: 'How StudyForge stays free for every student.',
};

export default function AboutPage() {
  return (
    <main className="prose prose-neutral mx-auto max-w-2xl px-6 py-12 dark:prose-invert">
      <h1>StudyForge is free. Forever.</h1>

      <p>
        StudyForge is an AI-powered learning workspace that turns your
        course materials into a tutor, flashcards, quizzes, a study plan,
        and a knowledge graph — all grounded in citations from your own
        uploads. We built it so any student, anywhere, can use it without
        a credit card, a subscription, or a paywall.
      </p>

      <h2>How does it stay free?</h2>
      <ul>
        <li>
          <strong>Free-tier provider rotation.</strong> Generation calls
          land on free tiers from Groq, Gemini, OpenRouter, HuggingFace,
          Cerebras, Together, Fireworks, and Ollama. The router picks
          whichever provider is healthy and within quota.
        </li>
        <li>
          <strong>50 AI requests per day, per account.</strong> The cap
          keeps any one user from draining the platform key. Resets at
          midnight UTC.
        </li>
        <li>
          <strong>BYOK for unlimited use.</strong> Add your own provider
          key in{' '}
          <Link href="/settings/byok" className="underline">
            Settings
          </Link>{' '}
          and the cap goes away. Keys are envelope-encrypted (AES-256-GCM
          with a per-tenant DEK) before they touch the database; only the
          last four characters are ever shown.
        </li>
        <li>
          <strong>WebLLM in your browser.</strong> Or skip the cloud
          entirely — a 1B-parameter model runs locally via WebGPU. No
          data leaves your machine.
        </li>
        <li>
          <strong>Self-host the whole stack.</strong> Open source, MIT
          licensed. <code>docker compose up</code> and you have your own
          StudyForge.
        </li>
      </ul>

      <h2>What we don't do</h2>
      <ul>
        <li>No ads. Ever.</li>
        <li>No selling your data. Your materials stay on your tenant.</li>
        <li>No upsells inside the product. There's nothing to upsell to.</li>
      </ul>

      <h2>Built in the open</h2>
      <p>
        StudyForge is built and maintained by{' '}
        <a
          href="https://github.com/kappaborg"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          @kappaborg
        </a>
        . Star the project on GitHub if it helped — visibility helps more
        than money, and there's no money to give anyway. Pull requests are
        welcome.
      </p>
    </main>
  );
}
