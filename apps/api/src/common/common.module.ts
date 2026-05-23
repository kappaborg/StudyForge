import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import {
  IdempotencyInterceptor,
  InMemoryIdempotencyStore,
} from './idempotency.interceptor';
import { ProblemFilter } from './problem.filter';

/**
 * Cross-cutting bindings: global problem+json filter, idempotency interceptor,
 * and the default in-memory idempotency store (Redis-backed implementation
 * replaces this in Phase 1).
 */
@Global()
@Module({
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    InMemoryIdempotencyStore,
    {
      provide: APP_INTERCEPTOR,
      useFactory: (reflector: Reflector, store: InMemoryIdempotencyStore) =>
        new IdempotencyInterceptor(reflector, store),
      inject: [Reflector, InMemoryIdempotencyStore],
    },
  ],
  exports: [InMemoryIdempotencyStore],
})
export class CommonModule {}
