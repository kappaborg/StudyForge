import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { problemTypeFor, type ProblemDetails, ProblemException } from './problem';

/**
 * Global error filter. Every unhandled error becomes application/problem+json.
 * Internal details (stack traces, SQL fragments) are stripped; operators correlate
 * via traceId in OTel.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const problem = this.toProblem(exception, req);

    if (problem.status >= 500) {
      this.log.error(
        { code: problem.code, status: problem.status, path: req.url, traceId: problem.traceId },
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    reply
      .code(problem.status)
      .header('content-type', 'application/problem+json')
      .send(problem);
  }

  private toProblem(exception: unknown, req: FastifyRequest): ProblemDetails {
    const traceId = readTraceId(req);
    const tenantId = readTenantId(req);
    const instance = req.url;

    if (exception instanceof ProblemException) {
      return {
        type: problemTypeFor(exception.code),
        title: exception.title,
        status: exception.status,
        ...(exception.detail !== undefined ? { detail: exception.detail } : {}),
        instance,
        code: exception.code,
        traceId,
        tenantId,
        ...(exception.fields ? { fields: exception.fields } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const { code, title, detail, fields } = mapNestError(body, status);
      return {
        type: problemTypeFor(code),
        title,
        status,
        ...(detail !== undefined ? { detail } : {}),
        instance,
        code,
        traceId,
        tenantId,
        ...(fields ? { fields } : {}),
      };
    }

    // Unknown / programmer error.
    return {
      type: problemTypeFor('internal'),
      title: 'Internal server error',
      status: 500,
      instance,
      code: 'internal',
      traceId,
      tenantId,
    };
  }
}

function readTraceId(req: FastifyRequest): string | undefined {
  const header = req.headers['traceparent'];
  if (typeof header === 'string' && header.length > 0) {
    return header.split('-')[1];
  }
  return undefined;
}

function readTenantId(req: FastifyRequest): string | null {
  const cast = req as FastifyRequest & { tenantId?: string };
  return cast.tenantId ?? null;
}

interface NestErrorShape {
  code: string;
  title: string;
  detail?: string;
  fields?: Array<{ name: string; reason: string }>;
}

function mapNestError(body: unknown, status: number): NestErrorShape {
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b['message'])) {
      return {
        code: 'validation.failed',
        title: 'Request body failed validation',
        fields: (b['message'] as unknown[]).map((m) => ({ name: 'body', reason: String(m) })),
      };
    }
    if (typeof b['message'] === 'string') {
      return {
        code: defaultCodeForStatus(status),
        title: String(b['message']),
      };
    }
  }
  return { code: defaultCodeForStatus(status), title: defaultTitleForStatus(status) };
}

function defaultCodeForStatus(status: number): string {
  if (status === 400) return 'bad-request';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload-too-large';
  if (status === 415) return 'unsupported-media-type';
  if (status === 422) return 'unprocessable';
  if (status === 429) return 'rate-limited';
  return 'internal';
}

function defaultTitleForStatus(status: number): string {
  switch (status) {
    case 400: return 'Bad request';
    case 401: return 'Unauthenticated';
    case 403: return 'Forbidden';
    case 404: return 'Not found';
    case 409: return 'Conflict';
    case 413: return 'Payload too large';
    case 415: return 'Unsupported media type';
    case 422: return 'Unprocessable entity';
    case 429: return 'Too many requests';
    default:  return 'Error';
  }
}
