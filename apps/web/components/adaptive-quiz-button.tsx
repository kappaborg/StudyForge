'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { generateAdaptiveQuiz } from '../lib/mastery-client';
import { useToast } from './toast';

export function AdaptiveQuizButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const { quizId } = await generateAdaptiveQuiz();
      router.push(`/quizzes/${quizId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start adaptive quiz');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      className={`rounded-md bg-foreground ${
        compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
      } font-medium text-background hover:opacity-90 disabled:opacity-50`}
    >
      {busy ? 'Building quiz…' : 'Quiz me on my weakest concepts'}
    </button>
  );
}
