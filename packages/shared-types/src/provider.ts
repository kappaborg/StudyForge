import { z } from 'zod';

export const ProviderId = z.enum([
  'groq',
  'gemini',
  'gemini_free',
  'hf_inference',
  'openrouter',
  'openrouter_free',
  'cerebras',
  'together',
  'fireworks',
  'ollama',
  'webllm',
  'anthropic',
  'openai',
  'user_byok',
]);
export type ProviderId = z.infer<typeof ProviderId>;

export const ComplexityClass = z.enum(['simple', 'medium', 'complex', 'code', 'multi_doc']);
export type ComplexityClass = z.infer<typeof ComplexityClass>;

export const RouteRequest = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  tier: z.enum(['free', 'pro', 'byok', 'institutional']),
  complexity: ComplexityClass,
  estimatedInputTokens: z.number().int().nonnegative(),
  latencySloMs: z.number().int().positive(),
  byokKeyId: z.string().uuid().nullable(),
});
export type RouteRequest = z.infer<typeof RouteRequest>;

export const RouteDecision = z.object({
  providerId: ProviderId,
  model: z.string(),
  reason: z.string(),
  estimatedCostUsd: z.number().nonnegative(),
  cacheable: z.boolean(),
});
export type RouteDecision = z.infer<typeof RouteDecision>;
