/**
 * Typed Server-Sent Events client.
 *
 * Consumes the tutor / generation event schema defined in §4:
 *   event: meta      data: {sessionId, providerId, model, tier}
 *   event: token     data: {delta}
 *   event: citation  data: {chunkId, page?, score, spanStart?, spanEnd?}
 *   event: done      data: {tokensIn, tokensOut, cacheHit, costMicroUsd}
 *   event: error     data: {code, message}
 *
 * Closes on `done` / `error` / abort. Components consume via async iteration.
 */

export interface SseMetaEvent {
  type: 'meta';
  sessionId: string;
  providerId: string;
  model: string;
  tier: 'free' | 'pro' | 'byok' | 'institutional';
}

export interface SseTokenEvent {
  type: 'token';
  delta: string;
}

export interface SseCitationEvent {
  type: 'citation';
  chunkId: string;
  page?: number;
  slide?: number;
  cell?: number;
  score: number;
  spanStart?: number;
  spanEnd?: number;
}

export interface SseDoneEvent {
  type: 'done';
  tokensIn: number;
  tokensOut: number;
  cacheHit: boolean;
  costMicroUsd: number;
}

export interface SseErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

export type SseEvent =
  | SseMetaEvent
  | SseTokenEvent
  | SseCitationEvent
  | SseDoneEvent
  | SseErrorEvent;

/**
 * Iterate the response body as typed SSE events. Throws on unparseable frames
 * — silently dropping malformed events makes regressions invisible.
 */
export async function* sseEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  if (response.body === null) {
    throw new Error('SSE response has no body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const onAbort = (): void => {
    void reader.cancel();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const evt = parseFrame(rawFrame);
        if (evt === null) continue; // heartbeat / comment
        yield evt;
        if (evt.type === 'done' || evt.type === 'error') {
          void reader.cancel();
          return;
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Parse a single SSE frame. Returns `null` for comment-only / heartbeat
 * frames. Throws on malformed `data:` payloads.
 */
export function parseFrame(rawFrame: string): SseEvent | null {
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const rawLine of rawFrame.split('\n')) {
    const line = rawLine.trimEnd();
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).trimStart();
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (eventName === null || dataLines.length === 0) return null;

  const payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
  switch (eventName) {
    case 'meta':
      return { type: 'meta', ...(payload as Omit<SseMetaEvent, 'type'>) };
    case 'token':
      return { type: 'token', delta: String(payload['delta'] ?? '') };
    case 'citation':
      return { type: 'citation', ...(payload as Omit<SseCitationEvent, 'type'>) };
    case 'done':
      return { type: 'done', ...(payload as Omit<SseDoneEvent, 'type'>) };
    case 'error':
      return { type: 'error', ...(payload as Omit<SseErrorEvent, 'type'>) };
    case 'ping':
      return null;
    default:
      throw new Error(`unknown SSE event: ${eventName}`);
  }
}
