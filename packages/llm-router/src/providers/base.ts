import type { ProviderId } from '@studyforge/shared-types';
import type { CompletionChunk, CompletionRequest, CompletionResult } from '../types';

/**
 * All concrete provider adapters implement this interface.
 * No business logic may import provider SDKs directly — go through a Provider instance.
 */
export interface Provider {
  readonly id: ProviderId;
  readonly supportsPromptCache: boolean;
  readonly supportsStreaming: boolean;
  readonly contextWindowTokens: number;

  complete(req: CompletionRequest): Promise<CompletionResult>;
  stream(req: CompletionRequest): AsyncIterable<CompletionChunk>;

  /**
   * Lightweight reachability probe used by the circuit breaker and BYOK validation.
   */
  ping(): Promise<{ ok: boolean; latencyMs: number }>;
}

export abstract class BaseProvider implements Provider {
  abstract readonly id: ProviderId;
  abstract readonly supportsPromptCache: boolean;
  abstract readonly supportsStreaming: boolean;
  abstract readonly contextWindowTokens: number;

  abstract complete(req: CompletionRequest): Promise<CompletionResult>;
  abstract stream(req: CompletionRequest): AsyncIterable<CompletionChunk>;

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.complete({
        decision: {
          providerId: this.id,
          model: 'default',
          reason: 'ping',
          estimatedCostUsd: 0,
          cacheable: false,
        },
        systemPrompt: 'You are a health check.',
        userMessages: [{ role: 'user', content: 'ping' }],
        maxOutputTokens: 1,
        temperature: 0,
        stream: false,
      });
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
