import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { ProblemException } from '../common/problem';
import { FoldersService } from '../folders/folders.service';
import { LocalModelsService } from '../local-models/local-models.service';
import { PrismaService } from '../prisma/prisma.service';

// Non-terminal upload states. While a batch sits in any of these, the
// associated document is still being processed and must not be removed
// out from under the worker.
const INFLIGHT_STATES = [
  'initiated',
  'uploading',
  'uploaded',
  'scanning',
  'extracting',
  'embedding',
] as const;

interface ImpactDto {
  ingestionInFlight: boolean;
  artifactCounts: {
    flashcardDecks: number;
    quizzes: number;
    roadmaps: number;
    concepts: number;
  };
  folderId: string | null;
}

@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly folders: FoldersService,
    private readonly localModels: LocalModelsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List documents in the current tenant' })
  async list(
    @CurrentUser() user: AuthContext,
    @Query('courseId') courseId?: string,
    @Query('folderId') folderId?: string,
    @Query('includeTrashed') includeTrashed?: string,
    @Query('limit') limit = '20',
  ): Promise<Array<{
    id: string;
    originalFilename: string;
    mime: string;
    pageCount: number | null;
    chunkCount: number;
    folderId: string | null;
    deletedAt: string | null;
    createdAt: string;
  }>> {
    const n = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const showTrashed = includeTrashed === '1' || includeTrashed === 'true';
    const rows = await this.prisma.document.findMany({
      where: {
        tenantId: user.tenantId,
        ...(showTrashed ? {} : { deletedAt: null }),
        ...(courseId ? { courseId } : {}),
        ...(folderId ? { folderId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: n,
      include: {
        versions: {
          include: { _count: { select: { chunks: true } } },
        },
      },
    });
    return rows.map((row) => {
      const chunks = row.versions.reduce(
        (sum, v) => sum + (v._count?.chunks ?? 0),
        0,
      );
      return {
        id: row.id,
        originalFilename: row.originalFilename,
        mime: row.mime,
        pageCount: row.pageCount,
        chunkCount: chunks,
        folderId: row.folderId,
        deletedAt: row.deletedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Document detail + versions + chunk count' })
  async detail(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{
    id: string;
    originalFilename: string;
    mime: string;
    pageCount: number | null;
    chunkCount: number;
    createdAt: string;
  }> {
    const row = await this.prisma.document.findUnique({
      where: { id },
      include: {
        versions: { include: { _count: { select: { chunks: true } } } },
      },
    });
    if (row === null || row.tenantId !== user.tenantId || row.deletedAt !== null) {
      throw new ProblemException({
        status: 404,
        code: 'document.not-found',
        title: 'Document not found',
      });
    }
    return {
      id: row.id,
      originalFilename: row.originalFilename,
      mime: row.mime,
      pageCount: row.pageCount,
      chunkCount: row.versions.reduce(
        (sum, v) => sum + (v._count?.chunks ?? 0),
        0,
      ),
      createdAt: row.createdAt.toISOString(),
    };
  }

  @Get(':id/impact')
  @ApiOperation({
    summary:
      'Surface what deletion would touch: in-flight ingestion + artifacts in this folder',
  })
  async impact(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ImpactDto> {
    const doc = await this.requireOwnedDocument(user.tenantId, id, {
      allowTrashed: true,
    });
    const ingestionInFlight = await this.isIngestionInFlight(
      doc.uploadBatchId,
    );
    const counts = await this.countFolderArtifacts(user.tenantId, doc.courseId, doc.folderId);
    return {
      ingestionInFlight,
      artifactCounts: counts,
      folderId: doc.folderId,
    };
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Soft-delete: move the material into Trash. Refuses while ingestion is in flight.',
  })
  async softDelete(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ id: string; trashedAt: string }> {
    const doc = await this.requireOwnedDocument(user.tenantId, id);
    if (await this.isIngestionInFlight(doc.uploadBatchId)) {
      throw new ProblemException({
        status: 409,
        code: 'document.ingestion-in-flight',
        title: 'Ingestion still running',
        detail:
          'This material is still being processed. Wait for ingestion to finish, then try again.',
      });
    }
    const trashFolderId = await this.folders.trashFolderId(user.tenantId);
    const sourceFolderId = doc.folderId;
    const now = new Date();
    const updated = await this.prisma.document.update({
      where: { id: doc.id },
      data: { deletedAt: now, folderId: trashFolderId },
    });
    if (sourceFolderId) {
      void this.localModels.markFolderStale(user.tenantId, sourceFolderId);
    }
    return {
      id: updated.id,
      trashedAt: (updated.deletedAt ?? now).toISOString(),
    };
  }

  @Post(':id/restore')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Restore a trashed document back to Inbox',
  })
  async restore(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ id: string; folderId: string }> {
    const doc = await this.requireOwnedDocument(user.tenantId, id, {
      allowTrashed: true,
    });
    if (doc.deletedAt === null) {
      // Idempotent: restoring an already-live doc is a no-op.
      return { id: doc.id, folderId: doc.folderId ?? '' };
    }
    const inboxFolderId = await this.folders.inboxFolderId(user.tenantId);
    const updated = await this.prisma.document.update({
      where: { id: doc.id },
      data: { deletedAt: null, folderId: inboxFolderId },
    });
    void this.localModels.markFolderStale(user.tenantId, inboxFolderId);
    return { id: updated.id, folderId: updated.folderId ?? inboxFolderId };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async requireOwnedDocument(
    tenantId: string,
    id: string,
    opts: { allowTrashed?: boolean } = {},
  ) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    const notFound = (): never => {
      throw new ProblemException({
        status: 404,
        code: 'document.not-found',
        title: 'Document not found',
      });
    };
    if (doc === null || doc.tenantId !== tenantId) return notFound();
    if (!opts.allowTrashed && doc.deletedAt !== null) return notFound();
    return doc;
  }

  private async isIngestionInFlight(uploadBatchId: string): Promise<boolean> {
    const batch = await this.prisma.uploadBatch.findUnique({
      where: { id: uploadBatchId },
      select: { state: true },
    });
    if (!batch) return false;
    return (INFLIGHT_STATES as readonly string[]).includes(batch.state);
  }

  private async countFolderArtifacts(
    tenantId: string,
    courseId: string | null,
    folderId: string | null,
  ): Promise<ImpactDto['artifactCounts']> {
    // Personal-flow artifacts are persisted at the course level (typically
    // the per-tenant Inbox course). A precise document→artifact mapping
    // would require walking Citation rows; here we surface the looser
    // signal: artifacts on the same course as the doc, hinted by folder.
    if (!courseId) {
      return { flashcardDecks: 0, quizzes: 0, roadmaps: 0, concepts: 0 };
    }
    const _folderId = folderId; // reserved for a future folder-scoped count
    void _folderId;
    const [flashcardDecks, quizzes, roadmaps, concepts] = await Promise.all([
      this.prisma.flashcardDeck.count({
        where: { courseId, deletedAt: null, course: { tenantId } },
      }),
      this.prisma.quiz.count({
        where: { courseId, deletedAt: null, course: { tenantId } },
      }),
      this.prisma.roadmap.count({
        where: { courseId, deletedAt: null, course: { tenantId } },
      }),
      this.prisma.concept.count({
        where: { courseId, course: { tenantId } },
      }),
    ]);
    return { flashcardDecks, quizzes, roadmaps, concepts };
  }
}
