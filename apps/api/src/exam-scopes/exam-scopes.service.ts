import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../prisma/prisma.service';

export type ScopeMode = 'theory' | 'problems';

export interface ScopeEntry {
  mode: ScopeMode;
  chapters: number[];
  topics: string[];
}

export interface ExamScopeDto {
  id: string;
  folderId: string;
  folderName: string;
  title: string;
  examDate: string | null;
  scopes: ScopeEntry[];
  rawText: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExamScopeInput {
  folderId: string;
  title: string;
  scopes: ScopeEntry[];
  examDate?: string | null;
  rawText?: string | null;
}

export interface UpdateExamScopeInput {
  title?: string;
  scopes?: ScopeEntry[];
  examDate?: string | null;
}

const AI_WORKER_URL = process.env['AI_WORKER_URL'] ?? 'http://localhost:8001';

@Injectable()
export class ExamScopesService {
  private readonly log = new Logger(ExamScopesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, userId: string): Promise<ExamScopeDto[]> {
    const rows = await this.prisma.examScope.findMany({
      where: { tenantId, userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: { folder: true },
    });
    return rows.map(toDto);
  }

  async get(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<ExamScopeDto> {
    const row = await this.requireOwned(tenantId, userId, id);
    return toDto(row);
  }

  async create(
    tenantId: string,
    userId: string,
    input: CreateExamScopeInput,
  ): Promise<ExamScopeDto> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: input.folderId },
    });
    if (!folder || folder.tenantId !== tenantId) {
      throw new ProblemException({
        status: 404,
        code: 'exam-scope.folder-not-found',
        title: 'Folder not found',
      });
    }
    if (folder.kind === 'trash') {
      throw new ProblemException({
        status: 400,
        code: 'exam-scope.invalid-folder',
        title: 'Cannot scope to Trash',
      });
    }
    const row = await this.prisma.examScope.create({
      data: {
        tenantId,
        userId,
        folderId: input.folderId,
        title: input.title.slice(0, 200),
        scopes: input.scopes as unknown as Prisma.InputJsonValue,
        examDate: input.examDate ? new Date(input.examDate) : null,
        rawText: input.rawText?.slice(0, 8000) ?? null,
      },
      include: { folder: true },
    });
    return toDto(row);
  }

  async update(
    tenantId: string,
    userId: string,
    id: string,
    input: UpdateExamScopeInput,
  ): Promise<ExamScopeDto> {
    const owned = await this.requireOwned(tenantId, userId, id);
    const row = await this.prisma.examScope.update({
      where: { id: owned.id },
      data: {
        ...(input.title !== undefined ? { title: input.title.slice(0, 200) } : {}),
        ...(input.scopes !== undefined
          ? { scopes: input.scopes as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.examDate !== undefined
          ? { examDate: input.examDate ? new Date(input.examDate) : null }
          : {}),
      },
      include: { folder: true },
    });
    return toDto(row);
  }

  async remove(tenantId: string, userId: string, id: string): Promise<void> {
    const owned = await this.requireOwned(tenantId, userId, id);
    await this.prisma.examScope.update({
      where: { id: owned.id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Calls the worker LLM endpoint to parse the professor's raw scope text
   * into a structured set of (mode, chapters, topics) entries. The student
   * still confirms before saving; we never auto-persist a parsed scope.
   */
  async parse(rawText: string): Promise<{ title: string; scopes: ScopeEntry[] }> {
    const res = await fetch(`${AI_WORKER_URL}/v1/exam-scopes/parse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: rawText }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new ProblemException({
        status: 502,
        code: 'exam-scope.parser-failed',
        title: 'Could not parse exam scope',
        detail,
      });
    }
    const json = (await res.json()) as { title: string; scopes: ScopeEntry[] };
    return json;
  }

  /**
   * Returns the union of chapters across all scope entries — used by the
   * retriever to filter chunk metadata in a single IN clause. Empty array
   * means "no chapter filter" (scope matched no chapters; let through).
   */
  unionChapters(scope: ExamScopeDto): number[] {
    const set = new Set<number>();
    for (const s of scope.scopes) {
      for (const c of s.chapters) set.add(c);
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  private async requireOwned(tenantId: string, userId: string, id: string) {
    const row = await this.prisma.examScope.findUnique({
      where: { id },
      include: { folder: true },
    });
    if (
      !row ||
      row.tenantId !== tenantId ||
      row.userId !== userId ||
      row.deletedAt !== null
    ) {
      throw new ProblemException({
        status: 404,
        code: 'exam-scope.not-found',
        title: 'Exam scope not found',
      });
    }
    return row;
  }
}

function toDto(row: {
  id: string;
  folderId: string;
  title: string;
  examDate: Date | null;
  scopes: unknown;
  rawText: string | null;
  createdAt: Date;
  updatedAt: Date;
  folder: { name: string };
}): ExamScopeDto {
  return {
    id: row.id,
    folderId: row.folderId,
    folderName: row.folder.name,
    title: row.title,
    examDate: row.examDate?.toISOString() ?? null,
    scopes: Array.isArray(row.scopes) ? (row.scopes as ScopeEntry[]) : [],
    rawText: row.rawText,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
