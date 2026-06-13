import 'reflect-metadata';
// Observability initialises first so Sentry can hook unhandled errors.
import { setupObservability } from './observability';
setupObservability();

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AuthService } from './auth/auth.service';
import { registerDevAuth } from './auth/dev-auth.plugin';
import { registerSessionAuth } from './auth/session-auth.plugin';
import fastifyCookie from '@fastify/cookie';

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

async function bootstrap() {
  const adapter = new FastifyAdapter({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
    bodyLimit: 100 * 1024 * 1024,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  app.enableShutdownHooks();
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? true,
    credentials: true,
  });
  adapter.getInstance().addHook('onSend', async (_req, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
  });

  await adapter.getInstance().register(fastifyCookie as any, {
    secret: process.env['SESSION_COOKIE_SECRET'] ?? 'studyforge-dev-secret-do-not-use-in-prod',
  });

  const authService = app.get(AuthService);
  registerDevAuth(adapter.getInstance(), authService);
  registerSessionAuth(adapter.getInstance(), authService);

  app.setGlobalPrefix('v1', {
    exclude: ['health', 'health/(.*)', 'docs', 'docs/(.*)'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('StudyForge AI API')
    .setDescription('Gateway for the StudyForge AI platform')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((err) => {
  console.error('Failed to start API gateway:', err);
  process.exit(1);
});
