// BKT-lite mastery update. Standard BKT has four params (init, learn,
// guess, slip); the lite variant keeps a single (0..1) mastery score with
// asymmetric updates — correct answers move mastery toward 1 along a
// learning curve, wrong answers pull it back by a slip penalty. Calibrate
// the rates against the eval harness later; the contract is more
// important than the numbers.
const LEARN_RATE = 0.4;
const SLIP_PENALTY = 0.7;
const INITIAL_MASTERY = 0.0;

export interface MasteryEntry {
  mastery: number;
  attempts: number;
  correct: number;
  lastSeenAt: string; // ISO
}

export type MasteryMap = Record<string, MasteryEntry>;

export function nextMastery(
  prev: MasteryEntry | undefined,
  correct: boolean,
  now = new Date(),
): MasteryEntry {
  const base = prev ?? {
    mastery: INITIAL_MASTERY,
    attempts: 0,
    correct: 0,
    lastSeenAt: now.toISOString(),
  };
  const m = base.mastery;
  const next = correct ? m + (1 - m) * LEARN_RATE : m * SLIP_PENALTY;
  return {
    mastery: Math.max(0, Math.min(1, next)),
    attempts: base.attempts + 1,
    correct: base.correct + (correct ? 1 : 0),
    lastSeenAt: now.toISOString(),
  };
}
