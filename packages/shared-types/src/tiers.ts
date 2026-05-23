import { z } from 'zod';

export const TierName = z.enum(['free', 'pro', 'byok', 'institutional']);
export type TierName = z.infer<typeof TierName>;

export const TokenBudget = z.object({
  daily: z.number().int().nonnegative(),
  monthly: z.number().int().nonnegative().or(z.literal('unlimited' as const)),
});
export type TokenBudget = z.infer<typeof TokenBudget>;

export const ExhaustPolicy = z.enum(['downshift', 'rate_limit', 'block']);
export type ExhaustPolicy = z.infer<typeof ExhaustPolicy>;

export const TierPolicy = z.object({
  name: TierName,
  budget: TokenBudget,
  providers: z.array(z.string()),
  onExhaust: ExhaustPolicy,
  billing: z.enum(['platform', 'user', 'institution']).default('platform'),
});
export type TierPolicy = z.infer<typeof TierPolicy>;
