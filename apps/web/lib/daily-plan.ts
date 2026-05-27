/**
 * Daily-plan composer.
 *
 * Pure-function reducer over the data the dashboard already pulls
 * (review stats + exam scopes + weakest concepts). No new server
 * endpoint, no per-user persistence — the plan is regenerated on each
 * dashboard load. Persistence comes if (and only if) we find people
 * want their "done today" state to stick across reloads.
 *
 * Time budget defaults to ~45 minutes. We allocate slots in a fixed
 * priority order so the same inputs always produce the same plan
 * (deterministic == testable + predictable for the user).
 */

import type { ExamScopeRow, ScopeEntry } from './exam-scopes-client';
import type { MasteryRow } from './mastery-client';
import type { ReviewStats } from './srs-client';

export type PlanItem =
  | {
      kind: 'review';
      label: string;
      minutes: number;
      href: string;
      hint: string;
    }
  | {
      kind: 'theory';
      label: string;
      minutes: number;
      href: string;
      hint: string;
      scopeId: string;
    }
  | {
      kind: 'problems';
      label: string;
      minutes: number;
      href: string;
      hint: string;
      scopeId: string;
    }
  | {
      kind: 'weakest';
      label: string;
      minutes: number;
      href: string;
      hint: string;
    }
  | {
      kind: 'starter';
      label: string;
      minutes: number;
      href: string;
      hint: string;
    };

export interface PlanInputs {
  reviewStats: ReviewStats;
  scopes: ExamScopeRow[];
  weakest: MasteryRow[];
}

const DEFAULT_BUDGET_MIN = 45;

export function buildDailyPlan(inputs: PlanInputs, budgetMin = DEFAULT_BUDGET_MIN): PlanItem[] {
  const out: PlanItem[] = [];
  let remaining = budgetMin;

  // ── Slot 1: spaced repetition ──────────────────────────────────────────
  // SRS due > 0 is the highest-yield action — short, time-boxed, directly
  // tied to retention. Cap at 20 min so a 200-card pile doesn't eat the
  // whole budget; the queue will roll forward naturally tomorrow.
  if (inputs.reviewStats.dueNow > 0 && remaining > 0) {
    const minutes = Math.min(remaining, 20, Math.max(5, Math.ceil(inputs.reviewStats.dueNow / 3)));
    out.push({
      kind: 'review',
      label: `Spaced repetition · ${inputs.reviewStats.dueNow} card${inputs.reviewStats.dueNow === 1 ? '' : 's'} due`,
      minutes,
      href: '/review',
      hint:
        inputs.reviewStats.reviewedToday > 0
          ? `Already reviewed ${inputs.reviewStats.reviewedToday} today — push through the rest.`
          : "Knock these out first; they're due now and won't take long.",
    });
    remaining -= minutes;
  }

  // ── Slots 2–3: scope-driven work, weighted by proximity to exam ────────
  // Pick the two nearest-upcoming scopes (sorted by examDate ascending,
  // undated scopes last). For each, schedule one block matching its mode.
  const activeScopes = pickActiveScopes(inputs.scopes, 2);
  for (const scope of activeScopes) {
    const daysOut = scope.examDate ? daysUntil(scope.examDate) : null;
    const urgency = daysOut === null ? 'baseline' : daysOut <= 3 ? 'crunch' : daysOut <= 14 ? 'soon' : 'baseline';

    // If the scope has both modes, prefer Problems within crunch window
    // (active recall beats re-reading); prefer Theory earlier in the cycle.
    const ordered =
      urgency === 'crunch'
        ? sortScopesByMode(scope.scopes, ['problems', 'theory'])
        : sortScopesByMode(scope.scopes, ['theory', 'problems']);
    const entry = ordered[0];
    if (!entry || remaining <= 0) continue;

    const minutes = Math.min(remaining, urgency === 'crunch' ? 20 : 15);
    if (minutes <= 0) continue;
    const href = `/exam-scopes/${scope.id}`;
    if (entry.mode === 'problems') {
      out.push({
        kind: 'problems',
        scopeId: scope.id,
        label: `Practice problems · ${scope.title}`,
        minutes,
        href,
        hint: `Chapters ${entry.chapters.join(', ') || '—'}${
          daysOut === null
            ? ' · no exam date set'
            : daysOut <= 0
              ? ' · exam past'
              : ` · exam in ${daysOut} day${daysOut === 1 ? '' : 's'}`
        }. Work 2–3 problems, walk through solutions.`,
      });
    } else {
      out.push({
        kind: 'theory',
        scopeId: scope.id,
        label: `Theory recap · ${scope.title}`,
        minutes,
        href,
        hint: `Chapters ${entry.chapters.join(', ') || '—'}. Ask the tutor a definition or comparison question.`,
      });
    }
    remaining -= minutes;
  }

  // ── Slot 4: weakest-concept drill ──────────────────────────────────────
  // Fills any remaining budget when there's no active scope (or after
  // scope blocks are placed). One concept at a time keeps the cognitive
  // load low — "drill this one thing" is easier to start than "study".
  const weakest = inputs.weakest.find((w) => w.attempts > 0);
  if (weakest && remaining >= 5) {
    const minutes = Math.min(remaining, 10);
    out.push({
      kind: 'weakest',
      label: `Drill weakest concept · ${weakest.label}`,
      minutes,
      href: '/mastery',
      hint: `${Math.round(weakest.mastery * 100)}% mastery in ${weakest.courseTitle}. Run an adaptive quiz from here.`,
    });
    remaining -= minutes;
  }

  // ── Empty-day fallback ─────────────────────────────────────────────────
  // First-run / brand-new account: surface the cheapest possible first
  // step so the dashboard isn't a dead end.
  if (out.length === 0) {
    if (inputs.scopes.length === 0 && inputs.reviewStats.totalCards === 0) {
      out.push({
        kind: 'starter',
        label: 'Upload your first material',
        minutes: 5,
        href: '/upload',
        hint: 'Drop a PDF lecture or chapter. Everything else hangs off this.',
      });
    } else if (inputs.scopes.length === 0) {
      out.push({
        kind: 'starter',
        label: 'Set your first exam scope',
        minutes: 3,
        href: '/dashboard',
        hint: 'Open a folder, click "Set exam scope", paste the professor’s message.',
      });
    } else {
      out.push({
        kind: 'starter',
        label: 'Take a quiz to seed mastery',
        minutes: 8,
        href: '/dashboard',
        hint: 'Open a folder → Quizzes tab. Submitting an attempt unlocks the adaptive loop.',
      });
    }
  }

  return out;
}

function pickActiveScopes(scopes: ExamScopeRow[], n: number): ExamScopeRow[] {
  // Exam-dated scopes win, sorted by closest first. Undated scopes fill
  // remaining slots in updated-at order (most recently edited == most
  // likely the one the student cares about now).
  const dated = scopes.filter((s) => s.examDate);
  const undated = scopes.filter((s) => !s.examDate);
  dated.sort((a, b) => {
    const ad = new Date(a.examDate!).getTime();
    const bd = new Date(b.examDate!).getTime();
    return ad - bd;
  });
  undated.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  // Drop already-past exams entirely; they're noise.
  const future = dated.filter((s) => daysUntil(s.examDate!) > -1);
  return [...future, ...undated].slice(0, n);
}

function sortScopesByMode(entries: ScopeEntry[], priority: Array<ScopeEntry['mode']>): ScopeEntry[] {
  return [...entries].sort(
    (a, b) => priority.indexOf(a.mode) - priority.indexOf(b.mode),
  );
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}
