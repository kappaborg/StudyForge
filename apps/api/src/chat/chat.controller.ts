import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { enforceBudget } from '../budget/budget-guard';
import { BudgetService } from '../budget/budget.service';
import { ProblemException } from '../common/problem';
import { SharedFoldersService } from '../shared-folders/shared-folders.service';
import { ChatService } from './chat.service';

class TutorAskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  query!: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsOptional()
  @IsUUID()
  folderId?: string;

  @IsOptional()
  @IsUUID()
  sessionId?: string;

  // Exam-scope retrieval filter — chapter numbers union from a saved scope.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(128)
  @IsInt({ each: true })
  chapters?: number[];

  // 'theory' vs 'problems' switches the system-prompt style so the tutor
  // gives definitions vs. worked solutions. Honored client-side too.
  @IsOptional()
  @IsIn(['theory', 'problems'])
  mode?: 'theory' | 'problems';
}

class CreateSessionDto {
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;
}

interface TutorAskResponseDto {
  refusal: boolean;
  text: string;
  citations: Array<{ chunkId: string; docId: string; page: number | null; score: number }>;
  suggestions: string[];
  retrievedChunkCount: number;
}

const AI_WORKER_URL = process.env['AI_WORKER_URL'] ?? 'http://localhost:8001';

@ApiTags('chat')
@Controller('chat')
export class ChatController {
  constructor(
    private readonly budget: BudgetService,
    private readonly chat: ChatService,
    private readonly shared: SharedFoldersService,
  ) {}

  // ── session CRUD ──────────────────────────────────────────────────────────

  @Get('sessions')
  @HttpCode(200)
  @ApiOperation({ summary: 'List the current user’s chat sessions' })
  async listSessions(@CurrentUser() user: AuthContext) {
    return { sessions: await this.chat.listSessions(user.tenantId, user.userId) };
  }

  @Post('sessions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create a new chat session' })
  async createSession(
    @CurrentUser() user: AuthContext,
    @Body() dto: CreateSessionDto,
  ) {
    return this.chat.createSession(user.tenantId, user.userId, {
      courseId: dto.courseId ?? null,
      title: dto.title,
    });
  }

  @Get('sessions/:id/messages')
  @HttpCode(200)
  @ApiOperation({ summary: 'List messages in a chat session' })
  async listMessages(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return {
      messages: await this.chat.listMessages(user.tenantId, user.userId, id),
    };
  }

  // ── tutor endpoints ───────────────────────────────────────────────────────

  @Post('tutor/ask')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ask the tutor a question; retrieves + answers in one call' })
  async ask(
    @CurrentUser() user: AuthContext,
    @Body() dto: TutorAskDto,
  ): Promise<TutorAskResponseDto> {
    await enforceBudget(this.budget, user.tenantId);

    let sessionId = dto.sessionId ?? null;
    if (sessionId) {
      await this.chat.requireOwnedSession(user.tenantId, user.userId, sessionId);
      await this.chat.appendUserMessage(sessionId, dto.query);
    }

    const allowedFolderIds = await this.shared.accessibleFolderIds(user.userId);
    const body = {
      tenant_id: user.tenantId,
      user_id: user.userId,
      session_id: sessionId ?? '00000000-0000-0000-0000-000000000000',
      course_id: dto.courseId ?? null,
      folder_id: dto.folderId ?? null,
      ...(dto.chapters && dto.chapters.length > 0 ? { chapters: dto.chapters } : {}),
      ...(allowedFolderIds.length > 0 ? { allowed_folder_ids: allowedFolderIds } : {}),
      query: applyModePrefix(dto.query, dto.mode),
      top_k: 5,
    };
    const res = await fetch(`${AI_WORKER_URL}/v1/tutor/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new ProblemException({
        status: 502,
        code: 'tutor.upstream-failed',
        title: 'Tutor pipeline failed',
        detail,
      });
    }
    const json = (await res.json()) as {
      refusal: boolean;
      text: string;
      citations: Array<{ chunk_id: string; doc_id: string; page: number | null; score: number }>;
      suggestions: string[];
      retrieved_chunk_count: number;
    };

    if (sessionId) {
      await this.chat.appendAssistantMessage(sessionId, json.text, {
        refusal: json.refusal,
        citations: json.citations.map((c) => ({ chunkId: c.chunk_id, score: c.score })),
      });
    }

    return {
      refusal: json.refusal,
      text: json.text,
      citations: json.citations.map((c) => ({
        chunkId: c.chunk_id,
        docId: c.doc_id,
        page: c.page,
        score: c.score,
      })),
      suggestions: json.suggestions,
      retrievedChunkCount: json.retrieved_chunk_count,
    };
  }

  @Post('tutor/stream')
  @ApiOperation({ summary: 'Stream the tutor answer over SSE' })
  async stream(
    @CurrentUser() user: AuthContext,
    @Body() dto: TutorAskDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await enforceBudget(this.budget, user.tenantId);

    let sessionId = dto.sessionId ?? null;
    if (sessionId) {
      await this.chat.requireOwnedSession(user.tenantId, user.userId, sessionId);
      await this.chat.appendUserMessage(sessionId, dto.query);
    }

    const allowedFolderIds = await this.shared.accessibleFolderIds(user.userId);
    const body = {
      tenant_id: user.tenantId,
      user_id: user.userId,
      session_id: sessionId ?? '00000000-0000-0000-0000-000000000000',
      course_id: dto.courseId ?? null,
      folder_id: dto.folderId ?? null,
      ...(dto.chapters && dto.chapters.length > 0 ? { chapters: dto.chapters } : {}),
      ...(allowedFolderIds.length > 0 ? { allowed_folder_ids: allowedFolderIds } : {}),
      query: applyModePrefix(dto.query, dto.mode),
      top_k: 5,
    };
    const upstream = await fetch(`${AI_WORKER_URL}/v1/tutor/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!upstream.ok || !upstream.body) {
      const detail = (await upstream.text()).slice(0, 400);
      throw new ProblemException({
        status: 502,
        code: 'tutor.stream-failed',
        title: 'Tutor stream failed',
        detail,
      });
    }
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.setHeader('x-accel-buffering', 'no');
    // SSE writes go directly to reply.raw, which bypasses Fastify's
    // onSend hook chain — and therefore bypasses Nest's CORS layer.
    // We have to set the CORS headers ourselves before the first write
    // or the browser rejects the entire stream with a CORS error.
    // The Origin header is echoed back (rather than '*') because the
    // FE sends credentials: 'include' and Allow-Origin '*' is invalid
    // alongside Allow-Credentials: true.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin) {
      reply.raw.setHeader('access-control-allow-origin', origin);
      reply.raw.setHeader('access-control-allow-credentials', 'true');
      reply.raw.setHeader('vary', 'origin');
    }

    // Accumulators for post-stream persistence. We forward upstream bytes
    // verbatim to the client and parse a copy in-memory to derive the final
    // assistant message + citations after the ``done`` event lands.
    const decoder = new TextDecoder();
    let buffer = '';
    let finalText = '';
    let runningDelta = '';
    let refusal = false;
    const citations: Array<{ chunkId: string; score: number }> = [];

    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        reply.raw.write(value);
        buffer += decoder.decode(value, { stream: true });
        // SSE events are delimited by a blank line. Parse complete frames
        // and leave the trailing partial in the buffer.
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          if (parsed.event === 'delta' && typeof parsed.data?.['text'] === 'string') {
            runningDelta += parsed.data['text'] as string;
          } else if (parsed.event === 'citations') {
            const list = (parsed.data?.['citations'] ?? []) as Array<{
              chunkId?: string;
              score?: number;
            }>;
            for (const c of list) {
              if (typeof c.chunkId === 'string') {
                citations.push({ chunkId: c.chunkId, score: c.score ?? 0 });
              }
            }
          } else if (parsed.event === 'refusal') {
            refusal = true;
            const text = parsed.data?.['text'];
            if (typeof text === 'string') finalText = text;
          } else if (parsed.event === 'done') {
            const text = parsed.data?.['text'];
            if (typeof text === 'string' && text.length > 0) finalText = text;
          }
        }
      }
    } finally {
      reply.raw.end();
    }

    if (sessionId) {
      const content = finalText || runningDelta;
      if (content) {
        await this.chat
          .appendAssistantMessage(sessionId, content, { refusal, citations })
          .catch((err) => {
            // Persistence failure shouldn't break the user-visible stream,
            // which has already flushed. Log and move on.
            // eslint-disable-next-line no-console
            console.error('chat.persist_assistant_failed', err);
          });
      }
    }
  }
}

function parseSseFrame(
  frame: string,
): { event: string; data: Record<string, unknown> } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Prepends a small instruction snippet to the user's query so the tutor
 * agent shifts its answer style without us needing a separate model or
 * agent variant. The worker's tutor agent already biases toward "answer
 * from the cited chunks"; the snippet just nudges the *form*.
 *
 *   theory   → conceptual explanations, definitions, comparisons
 *   problems → walk through worked solutions, generate similar practice
 *
 * Lives at the gateway because both the cloud (cloud Llama) and offline
 * (browser Llama) paths benefit from the same snippet, but only the cloud
 * path passes through here. The offline path applies its own analogous
 * snippet in ``components/offline-tutor.tsx``.
 */
function applyModePrefix(query: string, mode: 'theory' | 'problems' | undefined): string {
  if (mode === 'problems') {
    return [
      'I want a problem-solving walkthrough.',
      'Show steps, formulas, and the final answer.',
      'If applicable, generate a similar practice problem and solve it briefly.',
      '',
      `Question: ${query}`,
    ].join('\n');
  }
  if (mode === 'theory') {
    return [
      'I want a conceptual explanation.',
      'Define key terms, compare/contrast where useful, and ground every claim in the cited chunks.',
      '',
      `Question: ${query}`,
    ].join('\n');
  }
  return query;
}
