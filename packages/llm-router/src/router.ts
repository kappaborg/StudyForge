import type { ProviderId, RouteDecision, RouteRequest } from '@studyforge/shared-types';
import type { ProviderQuotaState } from './types';

/**
 * Free-tier-first routing. Order is the deliberate policy from §13 of the spec.
 * Producers (apps/api, apps/ai-worker) MUST go through this — never call provider SDKs directly.
 */
export const FREE_FIRST_ORDER: ProviderId[] = [
  'webllm',
  'ollama',
  'groq',
  'gemini_free',
  'hf_inference',
  'openrouter_free',
  'cerebras',
  'together',
  'fireworks',
  'gemini',
  'openrouter',
  'anthropic',
  'openai',
];

export interface RouterDeps {
  quotaState(): Promise<Record<ProviderId, ProviderQuotaState>>;
  resolveByokKey(byokKeyId: string): Promise<{ providerId: ProviderId; model: string } | null>;
}

export class FreeFirstRouter {
  constructor(private readonly deps: RouterDeps) {}

  async decide(req: RouteRequest): Promise<RouteDecision> {
    if (req.byokKeyId) {
      const byok = await this.deps.resolveByokKey(req.byokKeyId);
      if (byok) {
        return {
          providerId: 'user_byok',
          model: byok.model,
          reason: 'BYOK key present — bypassing platform quotas.',
          estimatedCostUsd: 0,
          cacheable: true,
        };
      }
    }

    const quotas = await this.deps.quotaState();
    const candidates = this.candidatesForComplexity(req.complexity);

    for (const providerId of candidates) {
      const q = quotas[providerId];
      if (!q || !q.healthy) continue;
      if (q.tokensRemainingInWindow < req.estimatedInputTokens) continue;

      return {
        providerId,
        model: this.modelFor(providerId, req.complexity),
        reason: `Selected first healthy provider in free-first order for complexity=${req.complexity}.`,
        estimatedCostUsd: this.estimateCost(providerId, req.estimatedInputTokens),
        cacheable: true,
      };
    }

    return {
      providerId: 'openai',
      model: 'gpt-4o-mini',
      reason: 'All preferred providers unavailable; falling back to paid frontier (low-tier).',
      estimatedCostUsd: this.estimateCost('openai', req.estimatedInputTokens),
      cacheable: true,
    };
  }

  private candidatesForComplexity(complexity: RouteRequest['complexity']): ProviderId[] {
    switch (complexity) {
      case 'simple':
        return ['webllm', 'groq', 'gemini_free', 'openrouter_free'];
      case 'medium':
        return ['groq', 'gemini_free', 'cerebras', 'openrouter_free'];
      case 'code':
        return ['openrouter_free', 'groq', 'gemini_free', 'anthropic', 'openai'];
      case 'multi_doc':
        return ['gemini_free', 'gemini', 'anthropic', 'openai'];
      case 'complex':
        return ['anthropic', 'openai', 'gemini'];
    }
  }

  private modelFor(providerId: ProviderId, complexity: RouteRequest['complexity']): string {
    const table: Partial<Record<ProviderId, Record<RouteRequest['complexity'], string>>> = {
      groq: {
        simple: 'llama-3.1-8b-instant',
        medium: 'llama-3.3-70b-versatile',
        code: 'llama-3.3-70b-versatile',
        complex: 'llama-3.3-70b-versatile',
        multi_doc: 'llama-3.3-70b-versatile',
      },
      gemini_free: {
        simple: 'gemini-2.5-flash',
        medium: 'gemini-2.5-flash',
        code: 'gemini-2.5-flash',
        complex: 'gemini-2.5-pro',
        multi_doc: 'gemini-2.5-pro',
      },
      anthropic: {
        simple: 'claude-haiku-4-5-20251001',
        medium: 'claude-sonnet-4-6',
        code: 'claude-sonnet-4-6',
        complex: 'claude-opus-4-7',
        multi_doc: 'claude-opus-4-7',
      },
      openai: {
        simple: 'gpt-4o-mini',
        medium: 'gpt-4o',
        code: 'gpt-4o',
        complex: 'gpt-4o',
        multi_doc: 'gpt-4o',
      },
    };
    return table[providerId]?.[complexity] ?? 'default';
  }

  private estimateCost(providerId: ProviderId, inputTokens: number): number {
    const usdPerMillionInput: Partial<Record<ProviderId, number>> = {
      webllm: 0,
      ollama: 0,
      groq: 0,
      gemini_free: 0,
      hf_inference: 0,
      openrouter_free: 0,
      cerebras: 0,
      gemini: 0.075,
      anthropic: 3,
      openai: 0.15,
    };
    const rate = usdPerMillionInput[providerId] ?? 0;
    return (inputTokens / 1_000_000) * rate;
  }
}
