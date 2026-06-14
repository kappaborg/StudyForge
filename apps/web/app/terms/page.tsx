import Link from 'next/link';

export const metadata = {
  title: 'Terms',
  description:
    'The terms you agree to by using StudyForge — what you can do, what we don\'t guarantee.',
};

export default function TermsPage() {
  return (
    <main className="prose prose-neutral mx-auto max-w-2xl px-6 py-12 dark:prose-invert">
      <h1>Terms of Service</h1>
      <p className="text-sm text-muted-foreground">Last updated: 2026-06-13</p>

      <p>
        By creating an account or using StudyForge ("the Service"), you agree
        to these terms. They're written plainly because the people using this
        service are students.
      </p>

      <h2>1. What StudyForge is</h2>
      <p>
        An AI-powered learning workspace that turns materials you upload into
        a tutor, flashcards, quizzes, a study plan, and a knowledge graph,
        all grounded in citations from your own uploads. See{' '}
        <Link href="/about">About</Link> for the details.
      </p>

      <h2>2. Your account</h2>
      <ul>
        <li>
          You must be at least 13 years old (or 16 in the EU). If you're a
          minor, your parent or guardian must agree to these terms on your
          behalf.
        </li>
        <li>
          Use accurate sign-in info and keep your Google account secure. You
          are responsible for everything that happens under your account.
        </li>
        <li>One account per person. Don't share, resell, or transfer it.</li>
      </ul>

      <h2>3. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>
          Upload content you don't have the right to (copyrighted material
          without permission, leaked exam papers, anything illegal).
        </li>
        <li>
          Use the Service to harass, defame, or harm anyone, or to generate
          content that does so.
        </li>
        <li>
          Try to attack the Service — no scraping, DDoS, prompt injection
          aimed at extracting other users' data, no scanning for
          vulnerabilities without permission.
        </li>
        <li>
          Resell access, automate sign-up to bypass the rate limits, or use
          the free tier in a way clearly meant to consume disproportionate
          resources.
        </li>
        <li>
          Use the Service to provide regulated professional advice (medical,
          legal, financial) to others as if the AI's output were authoritative.
        </li>
      </ul>
      <p>
        We may suspend or terminate accounts that violate these rules.
        Serious violations get reported to the right authorities.
      </p>

      <h2>4. Your content</h2>
      <p>
        You keep ownership of the materials you upload. You give us a
        non-exclusive license to process those materials only to provide the
        Service to you (chunking, embedding, indexing, displaying back to
        you, generating answers grounded in them). We don't use your
        content to train models, sell it to third parties, or share it with
        other users.
      </p>

      <h2>5. AI-generated content</h2>
      <p>
        The tutor, flashcards, quizzes, and other AI outputs are generated
        by large language models grounded in the materials you upload. They
        can be wrong. <strong>Verify against the source citations</strong>{' '}
        before relying on anything important — exams, assignments, real
        decisions. We provide AI output as a study aid, not as authoritative
        information.
      </p>

      <h2>6. Free tier</h2>
      <p>
        StudyForge is free. There's a per-account daily AI request cap to
        keep the free tier sustainable; you can lift it by adding your own
        provider key in Settings (BYOK). The Service is provided{' '}
        <strong>as-is</strong>, with no service-level guarantee. Free-tier
        infrastructure (Render dynos, Neon, Upstash) can sleep, throttle,
        or go down briefly.
      </p>

      <h2>7. Termination</h2>
      <p>
        You can delete your account anytime from Settings, or by emailing{' '}
        <a href="mailto:kayrayilmazedu203@gmail.com">
          kayrayilmazedu203@gmail.com
        </a>
        . We can suspend or terminate accounts for the reasons in §3, or if
        we're forced to by law. We'll give you notice unless that's not
        legally possible.
      </p>

      <h2>8. Disclaimers</h2>
      <p>
        We provide the Service WITHOUT WARRANTIES of any kind, express or
        implied, to the maximum extent permitted by law — no warranty of
        merchantability, fitness for a particular purpose, accuracy, or
        non-infringement. AI output is not professional advice.
      </p>

      <h2>9. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, StudyForge and its
        operators are not liable for indirect, incidental, special,
        consequential, or punitive damages arising from your use of the
        Service. Our total liability for any direct damages is capped at
        the amount you paid us in the prior 12 months — which, since the
        Service is free, is zero.
      </p>

      <h2>10. Changes to these terms</h2>
      <p>
        We'll update these terms when the Service changes. The "Last
        updated" date at the top moves with each change. Material changes
        get announced in-product. Continued use after a change means you
        accept it.
      </p>

      <h2>11. Governing law</h2>
      <p>
        These terms are governed by the laws of the operator's
        jurisdiction. Disputes go through the courts there unless your
        local consumer-protection law requires otherwise.
      </p>

      <h2>12. Contact</h2>
      <p>
        <a href="mailto:kayrayilmazedu203@gmail.com">
          kayrayilmazedu203@gmail.com
        </a>{' '}
        for anything in these terms.
      </p>

      <hr />
      <p className="text-xs text-muted-foreground">
        See also: <Link href="/privacy">Privacy Policy</Link> ·{' '}
        <Link href="/about">About</Link>
      </p>
    </main>
  );
}
