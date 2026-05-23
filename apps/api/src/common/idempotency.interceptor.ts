import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { Observable, tap } from 'rxjs';
import { ProblemException } from './problem';

/**
 * Decorator to mark a handler as requiring `Idempotency-Key`.
 *
 * Usage:
 *   @Post('uploads/init')
 *   @Idempotent()
 *   init(@Body() dto: UploadInitDto) { ... }
 */
export const IDEMPOTENT_METADATA = 'studyforge:idempotent';
export const Idempotent = (): MethodDecorator => SetMetadata(IDEMPOTENT_METADATA, true);

export interface IdempotencyStore {
  /**
   * Returns the previously-stored response when `bodyHash` matches the original
   * request body hash. Returns `'conflict'` when the same key was used with a
   * different body. Returns `null` when the key is unseen.
   */
  lookup(
    key: string,
    bodyHash: string,
  ): Promise<{ kind: 'hit'; status: number; body: unknown } | 'conflict' | null>;

  /** Persist the response associated with this (key, bodyHash). */
  store(
    key: string,
    bodyHash: string,
    payload: { status: number; body: unknown },
  ): Promise<void>;
}

const KEY_MIN = 16;
const KEY_MAX = 64;
const KEY_REGEX = /^[A-Za-z0-9_-]{16,64}$/;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: IdempotencyStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required =
      this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    if (!required) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const key = (req.headers['idempotency-key'] ?? '') as string;

    if (!key) {
      throw new ProblemException({
        status: 400,
        code: 'idempotency.key-missing',
        title: 'Idempotency-Key header is required',
        detail: `State-changing requests must include an Idempotency-Key (${KEY_MIN}–${KEY_MAX} chars, [A-Za-z0-9_-]).`,
      });
    }
    if (!KEY_REGEX.test(key)) {
      throw new ProblemException({
        status: 400,
        code: 'idempotency.key-malformed',
        title: 'Idempotency-Key is malformed',
      });
    }

    const bodyHash = hashBody(req.body);

    return new Observable((subscriber) => {
      this.store
        .lookup(key, bodyHash)
        .then(async (prior) => {
          if (prior === 'conflict') {
            subscriber.error(
              new ProblemException({
                status: 409,
                code: 'idempotency.key-conflict',
                title: 'Idempotency-Key was reused with a different request body',
              }),
            );
            return;
          }
          if (prior !== null) {
            reply.header('Idempotent-Replay', 'true').code(prior.status);
            subscriber.next(prior.body);
            subscriber.complete();
            return;
          }
          next
            .handle()
            .pipe(
              tap(async (body) => {
                const status = reply.statusCode ?? 200;
                await this.store.store(key, bodyHash, { status, body });
              }),
            )
            .subscribe({
              next: (value) => subscriber.next(value),
              error: (err) => subscriber.error(err),
              complete: () => subscriber.complete(),
            });
        })
        .catch((err) => subscriber.error(err));
    });
  }
}

function hashBody(body: unknown): string {
  const canonical = JSON.stringify(body ?? null);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * In-memory store. Replaced by a Redis-backed implementation in `apps/api/src/redis`
 * once that module lands. Useful as a default for tests and for the Phase 0 dev loop.
 */
@Injectable()
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly cache = new Map<string, { hash: string; status: number; body: unknown; expiresAt: number }>();
  private readonly ttlMs = 24 * 60 * 60 * 1000;

  async lookup(
    key: string,
    bodyHash: string,
  ): Promise<{ kind: 'hit'; status: number; body: unknown } | 'conflict' | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    if (entry.hash !== bodyHash) return 'conflict';
    return { kind: 'hit', status: entry.status, body: entry.body };
  }

  async store(
    key: string,
    bodyHash: string,
    payload: { status: number; body: unknown },
  ): Promise<void> {
    this.cache.set(key, { hash: bodyHash, ...payload, expiresAt: Date.now() + this.ttlMs });
  }
}
