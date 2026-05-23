/**
 * Defense-in-depth AI safety primitives:
 *  - prompt-injection scoring & content-channel separation
 *  - PII detection + redaction (Presidio integration)
 *  - moderation (OpenAI Moderation + custom classifier)
 *
 * Implementation lands in Phase 1 alongside ingestion.
 */
export const SAFETY_VERSION = '0.1.0';

export type ContentChannel = 'system' | 'tool' | 'trusted_user' | 'untrusted_document';

export interface InjectionScore {
  score: number;
  threshold: number;
  flagged: boolean;
  reasons: string[];
}
