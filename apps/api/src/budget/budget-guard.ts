import { ProblemException } from '../common/problem';
import type { BudgetService } from './budget.service';

/**
 * Tiny helper called at the top of every generation endpoint. Centralises
 * the 429 response shape so the FE can detect "you hit the daily cap" vs.
 * any other failure.
 */
export async function enforceBudget(
  budget: BudgetService,
  tenantId: string,
): Promise<void> {
  const decision = await budget.tryConsume(tenantId);
  if (decision.allowed) return;
  throw new ProblemException({
    status: 429,
    code: 'budget.daily-exhausted',
    title: 'Daily AI-request limit reached',
    detail: `You have used ${decision.dailyUsed} of ${decision.dailyLimit} daily free AI requests. They reset at midnight UTC, or add a BYOK provider key in Settings → Keys for unlimited use.`,
  });
}
