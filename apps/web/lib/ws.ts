/**
 * Reconnecting WebSocket client.
 *
 *   - Exponential backoff with jitter: 250 ms → 30 s, factor 2, ±50% jitter
 *   - Manual close stops reconnecting
 *   - Server-supplied `mid` field deduplicates redelivery on reconnect
 *   - Outbound messages buffer while disconnected and flush on open
 *   - Per-event-type handlers via `on(type, handler)` returning an unsubscriber
 *
 * Used by tutor sessions (tool-use confirmation, live cursors) and live
 * pipeline progress where the bidirectional channel is required.
 */

const MIN_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_FACTOR = 2;
const JITTER = 0.5;
const MAX_SEEN_IDS = 1024;

export interface WsMessage<T = unknown> {
  /** Event type, e.g. "tool.use", "cursor". */
  type: string;
  /** Optional message id used for redelivery deduplication. */
  mid?: string;
  payload: T;
}

export type WsHandler<T = unknown> = (msg: WsMessage<T>) => void;

export interface ReconnectingWsOptions {
  url: string;
  protocols?: string[];
  /** Override the WebSocket factory; defaults to the global. Useful for tests. */
  factory?: (url: string, protocols?: string[]) => WebSocket;
}

export class ReconnectingWs {
  private socket: WebSocket | null = null;
  private closedByUser = false;
  private backoff = MIN_BACKOFF_MS;
  private outbox: string[] = [];
  private seen: string[] = [];
  private handlers = new Map<string, Set<WsHandler>>();
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: ReconnectingWsOptions) {}

  open(): void {
    this.closedByUser = false;
    this.connect();
  }

  close(): void {
    this.closedByUser = true;
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.socket?.close(1000, 'client-close');
    this.socket = null;
  }

  send<T>(msg: WsMessage<T>): void {
    const frame = JSON.stringify(msg);
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(frame);
    } else {
      this.outbox.push(frame);
    }
  }

  on<T = unknown>(type: string, handler: WsHandler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler as WsHandler);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler as WsHandler);
    };
  }

  // ── internal ────────────────────────────────────────────────────────────

  private connect(): void {
    const factory = this.opts.factory ?? defaultFactory;
    const socket = factory(this.opts.url, this.opts.protocols);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.backoff = MIN_BACKOFF_MS;
      for (const frame of this.outbox) socket.send(frame);
      this.outbox = [];
    });

    socket.addEventListener('message', (ev) => {
      this.dispatch(typeof ev.data === 'string' ? ev.data : '');
    });

    socket.addEventListener('close', () => {
      if (this.closedByUser) return;
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // Browser implementations follow `error` with `close`; we only act on
      // close so we don't double-schedule.
    });
  }

  private scheduleReconnect(): void {
    const delay = applyJitter(this.backoff);
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.connect();
    }, delay);
    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * BACKOFF_FACTOR);
  }

  private dispatch(raw: string): void {
    if (raw === '') return;
    let parsed: WsMessage | null;
    try {
      parsed = JSON.parse(raw) as WsMessage;
    } catch {
      return;
    }
    if (parsed === null || typeof parsed.type !== 'string') return;

    if (typeof parsed.mid === 'string') {
      if (this.seen.includes(parsed.mid)) return;
      this.seen.push(parsed.mid);
      if (this.seen.length > MAX_SEEN_IDS) this.seen.shift();
    }

    const set = this.handlers.get(parsed.type);
    if (set === undefined) return;
    for (const handler of set) handler(parsed);
  }
}

function defaultFactory(url: string, protocols?: string[]): WebSocket {
  return new WebSocket(url, protocols);
}

export function applyJitter(base: number, rng: () => number = Math.random): number {
  // Result lives in [(1 - JITTER) * base, (1 + JITTER) * base].
  const min = (1 - JITTER) * base;
  const max = (1 + JITTER) * base;
  return Math.floor(min + rng() * (max - min));
}

export const __INTERNAL__ = {
  MIN_BACKOFF_MS,
  MAX_BACKOFF_MS,
  BACKOFF_FACTOR,
  JITTER,
};
