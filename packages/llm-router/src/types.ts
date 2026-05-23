import type { ProviderId, RouteDecision, RouteRequest } from '@studyforge/shared-types';

export interface ProviderQuotaState {
  providerId: ProviderId;
  requestsRemainingInWindow: number;
  tokensRemainingInWindow: number;
  windowResetAt: Date;
  healthy: boolean;
}

export interface CompletionRequest {
  decision: RouteDecision;
  systemPrompt: string;
  userMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Marker for prefix-cache eligibility. Provider adapters translate this into provider-specific
   *  cache markers (Anthropic cache_control, Gemini context-caching, OpenAI automatic). */
  cachePrefixBoundary?: number;
  maxOutputTokens: number;
  temperature: number;
  stream: boolean;
  abortSignal?: AbortSignal;
}

export interface CompletionChunk {
  delta: string;
  done: boolean;
  tokensIn?: number;
  tokensOut?: number;
  cacheHit?: boolean;
}

export interface CompletionResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  cacheHit: boolean;
  providerId: ProviderId;
  model: string;
}

export interface Router {
  decide(req: RouteRequest): Promise<RouteDecision>;
  complete(req: CompletionRequest): AsyncIterable<CompletionChunk> | Promise<CompletionResult>;
}
