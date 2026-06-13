/**
 * API observability — Sentry errors-only, env-gated.
 *
 * Sentry fires when ``SENTRY_DSN`` is set. We disable performance
 * tracing (use OTel for that) and ship ``sendDefaultPii: false``. A
 * ``beforeSend`` scrubs sensitive keys (api_key, content, etc.) from
 * any event payload — belt-and-braces over the PII flag.
 */

import * as Sentry from '@sentry/node';

const SENSITIVE_KEYS = new Set([
  'key',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'content',
]);

let initialized = false;

export function setupObservability(): void {
  if (initialized) return;
  initialized = true;
  const dsn = process.env['SENTRY_DSN'];
  if (!dsn) return;
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // ``beforeSend`` runs last; redact anything matching our sensitive
    // key list. Sentry won't ship a payload after this returns null.
    beforeSend(event) {
      scrub(event as unknown as Record<string, unknown>);
      return event;
    },
  });
  console.log('[observability] Sentry enabled (errors-only)');
}

function scrub(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) scrub(item);
    return;
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        obj[key] = '[REDACTED]';
      } else {
        scrub(obj[key]);
      }
    }
  }
}
