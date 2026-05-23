'use client';

import { useEffect, useState } from 'react';
import { track } from '../lib/analytics';
import { apiGet, apiPost, ApiError } from '../lib/dev-fetch';

interface QuizSummary {
  id: string;
  title: string;
  itemCount: number;
  createdAt: string;
}

interface QuizItem {
  id: string;
  prompt: string;
  options: string[];
  citations: Array<{ chunkId: string; page: number | null }>;
}

interface Quiz {
  id: string;
  title: string;
  items: QuizItem[];
}

interface Feedback {
  attemptId: string;
  score: number;
  perItem: Array<{
    itemId: string;
    correct: boolean;
    selectedIndex: number;
    correctIndex: number;
    rationale: string;
  }>;
}

export function QuizzesPanel({ courseId }: { courseId: string }) {
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [itemCount, setItemCount] = useState(5);
  const [difficulty, setDifficulty] = useState(50);

  const refreshQuizzes = async () => {
    try {
      const res = await apiGet<{ quizzes: QuizSummary[] }>(`/v1/courses/${courseId}/quizzes`);
      setQuizzes(res.quizzes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load quizzes');
    }
  };

  useEffect(() => {
    void refreshQuizzes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  const onGenerate = async () => {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await apiPost<Quiz>('/v1/quizzes/generate', {
        courseId,
        query: query.trim() || undefined,
        itemCount,
        difficulty,
      });
      setQuiz(res);
      setAnswers({});
      track('quizzes.generated', { courseId, itemCount: res.items.length, quizId: res.id });
      await refreshQuizzes();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Generation failed');
    } finally {
      setBusy(false);
    }
  };

  const openQuiz = async (id: string) => {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await apiGet<Quiz>(`/v1/quizzes/${id}`);
      setQuiz(res);
      setAnswers({});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to open quiz');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async () => {
    if (!quiz) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<Feedback>(`/v1/quizzes/${quiz.id}/submit`, { responses: answers });
      setFeedback(res);
      track('quizzes.submitted', { quizId: quiz.id, score: res.score, items: quiz.items.length });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submission failed');
    } finally {
      setBusy(false);
    }
  };

  const feedbackByItem = new Map(feedback?.perItem.map((f) => [f.itemId, f] as const));

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border p-4 space-y-3">
        <h3 className="text-sm font-semibold">Generate a new quiz</h3>
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">Topic (optional)</label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="leave empty for broad coverage"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="w-24">
            <label className="text-xs text-muted-foreground"># Questions</label>
            <input
              type="number"
              min={1}
              max={20}
              value={itemCount}
              onChange={(e) => setItemCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="w-28">
            <label className="text-xs text-muted-foreground">Difficulty</label>
            <input
              type="number"
              min={0}
              max={100}
              value={difficulty}
              onChange={(e) => setDifficulty(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={() => void onGenerate()}
            disabled={busy}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </section>

      {quizzes.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Your quizzes
          </h3>
          <ul className="divide-y divide-border rounded-md border border-border">
            {quizzes.map((q) => (
              <li key={q.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <div className="font-medium">{q.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {q.itemCount} questions · {new Date(q.createdAt).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={() => void openQuiz(q.id)}
                  className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
                >
                  Take
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {quiz && (
        <section className="space-y-4">
          <header className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">{quiz.title}</h3>
            {feedback && (
              <span className="text-sm font-semibold">
                Score: {(feedback.score * 100).toFixed(0)}%
              </span>
            )}
          </header>
          <ol className="space-y-4">
            {quiz.items.map((item, idx) => {
              const fb = feedbackByItem.get(item.id);
              return (
                <li key={item.id} className="rounded-lg border border-border p-4">
                  <p className="text-sm font-medium">
                    {idx + 1}. {item.prompt}
                  </p>
                  <ul className="mt-3 space-y-1">
                    {item.options.map((opt, i) => {
                      const selected = answers[item.id] === i;
                      const isCorrect = fb && fb.correctIndex === i;
                      const isWrong = fb && fb.selectedIndex === i && !fb.correct;
                      const cls = fb
                        ? isCorrect
                          ? 'border-green-500/60 bg-green-500/10'
                          : isWrong
                            ? 'border-red-500/60 bg-red-500/10'
                            : 'border-border'
                        : selected
                          ? 'border-foreground bg-accent'
                          : 'border-border hover:bg-accent';
                      return (
                        <li key={i}>
                          <button
                            type="button"
                            disabled={!!feedback}
                            onClick={() => setAnswers((prev) => ({ ...prev, [item.id]: i }))}
                            className={`block w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${cls}`}
                          >
                            <span className="mr-2 font-mono text-xs text-muted-foreground">
                              {String.fromCharCode(65 + i)}.
                            </span>
                            {opt}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {fb && (
                    <p className="mt-3 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
                      {fb.rationale}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          {!feedback && (
            <button
              onClick={() => void onSubmit()}
              disabled={busy || Object.keys(answers).length !== quiz.items.length}
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Grading…' : 'Submit answers'}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
