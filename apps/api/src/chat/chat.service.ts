import { Injectable, Logger } from '@nestjs/common';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../prisma/prisma.service';

export interface CitationInput {
  chunkId: string;
  score: number;
  spanStart?: number | null;
  spanEnd?: number | null;
}

@Injectable()
export class ChatService {
  private readonly log = new Logger(ChatService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listSessions(
    tenantId: string,
    userId: string,
    limit = 50,
  ): Promise<
    Array<{
      id: string;
      title: string | null;
      messageCount: number;
      updatedAt: string;
      createdAt: string;
    }>
  > {
    const rows = await this.prisma.chatSession.findMany({
      where: { tenantId, userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: { _count: { select: { messages: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      messageCount: r._count?.messages ?? 0,
      updatedAt: r.updatedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createSession(
    tenantId: string,
    userId: string,
    opts: { courseId?: string | null; title?: string } = {},
  ): Promise<{ id: string; title: string | null; createdAt: string }> {
    const row = await this.prisma.chatSession.create({
      data: {
        tenantId,
        userId,
        courseId: opts.courseId ?? null,
        title: opts.title ?? null,
      },
    });
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listMessages(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<
    Array<{
      id: string;
      role: string;
      content: string;
      refusal: boolean;
      createdAt: string;
      citations: Array<{ chunkId: string; score: number }>;
    }>
  > {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.tenantId !== tenantId || session.userId !== userId) {
      throw new ProblemException({
        status: 404,
        code: 'chat.session-not-found',
        title: 'Chat session not found',
      });
    }
    const rows = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      include: { citations: true },
    });
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      refusal: r.refusal,
      createdAt: r.createdAt.toISOString(),
      citations: r.citations.map((c) => ({ chunkId: c.chunkId, score: c.score })),
    }));
  }

  async requireOwnedSession(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<{ id: string; courseId: string | null }> {
    const row = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
    });
    if (!row || row.tenantId !== tenantId || row.userId !== userId) {
      throw new ProblemException({
        status: 404,
        code: 'chat.session-not-found',
        title: 'Chat session not found',
      });
    }
    return { id: row.id, courseId: row.courseId };
  }

  async appendUserMessage(sessionId: string, content: string): Promise<{ id: string }> {
    const row = await this.prisma.message.create({
      data: { sessionId, role: 'user', content },
    });
    await this.touchSession(sessionId, content);
    return { id: row.id };
  }

  async appendAssistantMessage(
    sessionId: string,
    content: string,
    opts: { refusal?: boolean; citations?: CitationInput[] } = {},
  ): Promise<{ id: string }> {
    const message = await this.prisma.message.create({
      data: {
        sessionId,
        role: 'assistant',
        content,
        refusal: opts.refusal ?? false,
      },
    });
    if (opts.citations && opts.citations.length > 0) {
      await this.prisma.citation.createMany({
        data: opts.citations.map((c) => ({
          messageId: message.id,
          chunkId: c.chunkId,
          score: c.score,
          spanStart: c.spanStart ?? null,
          spanEnd: c.spanEnd ?? null,
        })),
        skipDuplicates: true,
      });
    }
    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });
    return { id: message.id };
  }

  private async touchSession(sessionId: string, firstUserContent: string): Promise<void> {
    // Bump updatedAt so the session jumps to the top of the history list.
    // Backfill a title from the first user message if none has been set,
    // so the sidebar shows something meaningful before the user opens it.
    const existing = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: { title: true },
    });
    const title =
      existing && !existing.title
        ? firstUserContent.replace(/\s+/g, ' ').trim().slice(0, 80)
        : undefined;
    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        updatedAt: new Date(),
        ...(title ? { title } : {}),
      },
    });
  }
}
