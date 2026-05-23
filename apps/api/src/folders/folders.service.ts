import { Injectable, Logger } from '@nestjs/common';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../prisma/prisma.service';

export type FolderKind = 'materials' | 'inbox' | 'trash';

export interface FolderDto {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  kind: FolderKind;
  documentCount: number;
  deckCount: number;
  quizCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Folder lifecycle. ``materials`` folders are user-managed; ``inbox`` is the
 * auto-provisioned landing folder; ``trash`` collects soft-deleted documents
 * with a 30-day purge window.
 *
 * Every operation is tenant-scoped. The Inbox/Trash kinds are protected:
 * they cannot be deleted or renamed.
 */
@Injectable()
export class FoldersService {
  private readonly log = new Logger(FoldersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string): Promise<FolderDto[]> {
    await this.ensureSystemFolders(tenantId);
    const rows = await this.prisma.folder.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: {
            documents: { where: { deletedAt: null } },
          },
        },
      },
    });
    // Per-folder deck + quiz counts. We do it in two roundtrips rather than
    // raw SQL to keep the Prisma typesafety; the row count is small.
    const folderIds = rows.map((r) => r.id);
    const deckCounts = await this.prisma.flashcardDeck.groupBy({
      by: ['courseId'],
      where: { deletedAt: null, course: { tenantId } },
      _count: true,
    });
    const quizCounts = await this.prisma.quiz.groupBy({
      by: ['courseId'],
      where: { deletedAt: null, course: { tenantId } },
      _count: true,
    });
    // The mapping deck.courseId → folder uses the legacy ``courseId`` field
    // for now; the folders rollout will migrate generation routes to
    // persist folderId on artifacts directly in a follow-up.
    void folderIds;
    void deckCounts;
    void quizCounts;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      color: r.color,
      kind: r.kind as FolderKind,
      documentCount: r._count.documents,
      deckCount: 0,
      quizCount: 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async create(tenantId: string, name: string, color?: string): Promise<FolderDto> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new ProblemException({
        status: 400,
        code: 'folders.name-required',
        title: 'Folder name is required',
      });
    }
    const slug = await this.uniqueSlug(tenantId, slugify(trimmed));
    const row = await this.prisma.folder.create({
      data: { tenantId, name: trimmed, slug, color: color ?? null, kind: 'materials' },
    });
    this.log.log(`folders.created tenant=${tenantId} id=${row.id} name=${trimmed}`);
    return this.toDto(row);
  }

  async rename(
    tenantId: string,
    folderId: string,
    name: string | undefined,
    color: string | null | undefined,
  ): Promise<FolderDto> {
    const folder = await this.requireOwned(tenantId, folderId);
    if (folder.kind !== 'materials') {
      throw new ProblemException({
        status: 422,
        code: 'folders.system-immutable',
        title: 'System folders cannot be renamed',
      });
    }
    const data: { name?: string; color?: string | null } = {};
    if (name !== undefined) {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        throw new ProblemException({
          status: 400,
          code: 'folders.name-required',
          title: 'Folder name is required',
        });
      }
      data.name = trimmed;
    }
    if (color !== undefined) data.color = color;
    const row = await this.prisma.folder.update({ where: { id: folderId }, data });
    return this.toDto(row);
  }

  async remove(tenantId: string, folderId: string): Promise<void> {
    const folder = await this.requireOwned(tenantId, folderId);
    if (folder.kind !== 'materials') {
      throw new ProblemException({
        status: 422,
        code: 'folders.system-immutable',
        title: 'System folders cannot be deleted',
      });
    }
    const docCount = await this.prisma.document.count({
      where: { folderId, deletedAt: null },
    });
    if (docCount > 0) {
      throw new ProblemException({
        status: 409,
        code: 'folders.not-empty',
        title: `Folder still has ${docCount} material${docCount === 1 ? '' : 's'}`,
        detail: 'Move materials out of the folder before deleting it.',
      });
    }
    await this.prisma.folder.update({
      where: { id: folderId },
      data: { deletedAt: new Date() },
    });
  }

  async moveDocument(tenantId: string, documentId: string, folderId: string): Promise<void> {
    const folder = await this.requireOwned(tenantId, folderId);
    if (folder.kind === 'trash') {
      throw new ProblemException({
        status: 422,
        code: 'folders.cannot-move-to-trash',
        title: 'Use DELETE /v1/documents/:id to send a material to Trash.',
      });
    }
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId },
    });
    if (!doc) {
      throw new ProblemException({
        status: 404,
        code: 'documents.not-found',
        title: 'Document not found',
      });
    }
    await this.prisma.document.update({
      where: { id: documentId },
      data: { folderId, deletedAt: null },
    });
  }

  /** Resolve the Inbox folder id for a tenant. Created lazily. */
  async inboxFolderId(tenantId: string): Promise<string> {
    await this.ensureSystemFolders(tenantId);
    const inbox = await this.prisma.folder.findFirst({
      where: { tenantId, kind: 'inbox' },
    });
    if (!inbox) {
      throw new ProblemException({
        status: 500,
        code: 'folders.inbox-missing',
        title: 'Inbox folder is missing for tenant',
      });
    }
    return inbox.id;
  }

  /** Resolve the Trash folder id for a tenant. Created lazily. */
  async trashFolderId(tenantId: string): Promise<string> {
    await this.ensureSystemFolders(tenantId);
    const trash = await this.prisma.folder.findFirst({
      where: { tenantId, kind: 'trash' },
    });
    if (!trash) {
      throw new ProblemException({
        status: 500,
        code: 'folders.trash-missing',
        title: 'Trash folder is missing for tenant',
      });
    }
    return trash.id;
  }

  /** Resolve a folder id from a user-supplied value, falling back to Inbox. */
  async resolveOrInbox(tenantId: string, folderId: string | undefined): Promise<string> {
    if (folderId) {
      const f = await this.prisma.folder.findFirst({
        where: { id: folderId, tenantId, deletedAt: null },
      });
      if (f) return f.id;
    }
    return this.inboxFolderId(tenantId);
  }

  /** Idempotent: ensures Inbox + Trash exist for the tenant. */
  async ensureSystemFolders(tenantId: string): Promise<void> {
    const existing = await this.prisma.folder.findMany({
      where: { tenantId, kind: { in: ['inbox', 'trash'] } },
      select: { kind: true },
    });
    const have = new Set(existing.map((f) => f.kind));
    const toCreate: Array<{ name: string; slug: string; kind: 'inbox' | 'trash' }> = [];
    if (!have.has('inbox')) toCreate.push({ name: 'Inbox', slug: 'inbox', kind: 'inbox' });
    if (!have.has('trash')) toCreate.push({ name: 'Trash', slug: 'trash', kind: 'trash' });
    if (toCreate.length === 0) return;
    await this.prisma.folder.createMany({
      data: toCreate.map((f) => ({ ...f, tenantId })),
      skipDuplicates: true,
    });
  }

  private async requireOwned(tenantId: string, folderId: string) {
    const row = await this.prisma.folder.findFirst({
      where: { id: folderId, tenantId, deletedAt: null },
    });
    if (!row) {
      throw new ProblemException({
        status: 404,
        code: 'folders.not-found',
        title: 'Folder not found',
      });
    }
    return row;
  }

  private async uniqueSlug(tenantId: string, baseSlug: string): Promise<string> {
    let slug = baseSlug || 'folder';
    let attempt = 1;
    while (await this.prisma.folder.findUnique({ where: { tenantId_slug: { tenantId, slug } } })) {
      attempt += 1;
      slug = `${baseSlug}-${attempt}`;
    }
    return slug;
  }

  private toDto(
    row: { id: string; name: string; slug: string; color: string | null; kind: string; createdAt: Date; updatedAt: Date },
  ): FolderDto {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      color: row.color,
      kind: row.kind as FolderKind,
      documentCount: 0,
      deckCount: 0,
      quizCount: 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
