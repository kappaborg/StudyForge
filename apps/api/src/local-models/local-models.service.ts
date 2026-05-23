import { Injectable, Logger } from '@nestjs/common';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../prisma/prisma.service';

export interface LocalModelDto {
  id: string;
  folderId: string;
  folderName: string;
  status: 'building' | 'ready' | 'failed';
  stale: boolean;
  chunkCount: number;
  sizeBytes: number;
  embedderId: string | null;
  embedderDim: number | null;
  builtAt: string | null;
  createdAt: string;
}

export interface ChunkBundleEntry {
  chunkId: string;
  docId: string;
  filename: string;
  page: number | null;
  content: string;
}

@Injectable()
export class LocalModelsService {
  private readonly log = new Logger(LocalModelsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, userId: string): Promise<LocalModelDto[]> {
    const rows = await this.prisma.localModel.findMany({
      where: { tenantId, userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: { folder: true },
    });
    return rows.map(toDto);
  }

  async getByFolder(
    tenantId: string,
    userId: string,
    folderId: string,
  ): Promise<LocalModelDto | null> {
    const row = await this.prisma.localModel.findFirst({
      where: { tenantId, userId, folderId, deletedAt: null },
      include: { folder: true },
    });
    return row ? toDto(row) : null;
  }

  async createOrReset(
    tenantId: string,
    userId: string,
    folderId: string,
  ): Promise<LocalModelDto> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
    });
    if (!folder || folder.tenantId !== tenantId) {
      throw new ProblemException({
        status: 404,
        code: 'local-model.folder-not-found',
        title: 'Folder not found',
      });
    }
    if (folder.kind === 'trash') {
      throw new ProblemException({
        status: 400,
        code: 'local-model.invalid-folder',
        title: 'Cannot build a local model from Trash',
      });
    }
    // Upsert by the (userId, folderId) uniqueness constraint. If a model
    // already exists, reset it to `building` and clear the stale flag so
    // a rebuild reuses the same id (the dashboard card stays put).
    const row = await this.prisma.localModel.upsert({
      where: { userId_folderId: { userId, folderId } },
      create: {
        userId,
        tenantId,
        folderId,
        status: 'building',
        stale: false,
        chunkCount: 0,
        sizeBytes: 0n,
      },
      update: {
        status: 'building',
        stale: false,
        builtAt: null,
        deletedAt: null,
      },
      include: { folder: true },
    });
    return toDto(row);
  }

  async markBuilt(
    tenantId: string,
    userId: string,
    id: string,
    stats: {
      chunkCount: number;
      sizeBytes: number;
      embedderId: string;
      embedderDim: number;
    },
  ): Promise<LocalModelDto> {
    const owned = await this.requireOwned(tenantId, userId, id);
    const row = await this.prisma.localModel.update({
      where: { id: owned.id },
      data: {
        status: 'ready',
        chunkCount: stats.chunkCount,
        sizeBytes: BigInt(stats.sizeBytes),
        embedderId: stats.embedderId,
        embedderDim: stats.embedderDim,
        builtAt: new Date(),
        stale: false,
      },
      include: { folder: true },
    });
    return toDto(row);
  }

  async markFailed(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<LocalModelDto> {
    const owned = await this.requireOwned(tenantId, userId, id);
    const row = await this.prisma.localModel.update({
      where: { id: owned.id },
      data: { status: 'failed' },
      include: { folder: true },
    });
    return toDto(row);
  }

  async remove(tenantId: string, userId: string, id: string): Promise<void> {
    const owned = await this.requireOwned(tenantId, userId, id);
    await this.prisma.localModel.delete({ where: { id: owned.id } });
  }

  async listChunks(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<ChunkBundleEntry[]> {
    const owned = await this.requireOwned(tenantId, userId, id);
    // All chunks across all live documents in the folder, ordered for
    // deterministic indexing. We pull doc filename alongside so the
    // citation UI doesn't need a second round-trip.
    const docs = await this.prisma.document.findMany({
      where: {
        tenantId,
        folderId: owned.folderId,
        deletedAt: null,
      },
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
          include: {
            chunks: { orderBy: { ordinal: 'asc' } },
          },
        },
      },
    });
    const entries: ChunkBundleEntry[] = [];
    for (const doc of docs) {
      const v = doc.versions[0];
      if (!v) continue;
      for (const c of v.chunks) {
        entries.push({
          chunkId: c.id,
          docId: doc.id,
          filename: doc.originalFilename,
          page: c.page,
          content: c.content,
        });
      }
    }
    return entries;
  }

  /**
   * Marks any local model on this folder as stale, so the dashboard can
   * prompt a rebuild. Called from the uploads `complete` hook and from
   * document delete. Cheap; one row update per folder.
   */
  async markFolderStale(tenantId: string, folderId: string): Promise<void> {
    await this.prisma.localModel.updateMany({
      where: { tenantId, folderId, deletedAt: null, status: 'ready' },
      data: { stale: true },
    });
  }

  private async requireOwned(tenantId: string, userId: string, id: string) {
    const row = await this.prisma.localModel.findUnique({ where: { id } });
    if (
      !row ||
      row.tenantId !== tenantId ||
      row.userId !== userId ||
      row.deletedAt !== null
    ) {
      throw new ProblemException({
        status: 404,
        code: 'local-model.not-found',
        title: 'Local model not found',
      });
    }
    return row;
  }
}

function toDto(row: {
  id: string;
  folderId: string;
  status: string;
  stale: boolean;
  chunkCount: number;
  sizeBytes: bigint;
  embedderId: string | null;
  embedderDim: number | null;
  builtAt: Date | null;
  createdAt: Date;
  folder: { name: string };
}): LocalModelDto {
  return {
    id: row.id,
    folderId: row.folderId,
    folderName: row.folder.name,
    status: row.status as 'building' | 'ready' | 'failed',
    stale: row.stale,
    chunkCount: row.chunkCount,
    sizeBytes: Number(row.sizeBytes),
    embedderId: row.embedderId,
    embedderDim: row.embedderDim,
    builtAt: row.builtAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
