import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Single Prisma client for the gateway. Connects on module init, disconnects
 * cleanly on shutdown. NestJS calls onModuleDestroy when the app stops, which
 * lets pgBouncer / pgpool drop the connection slot promptly.
 *
 * Log levels stay quiet by default; flip to `query` via env for local debug.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: process.env['PRISMA_LOG'] === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
