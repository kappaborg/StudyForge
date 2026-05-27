import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../prisma/prisma.service';

export interface SharedFolderDto {
  id: string;
  folderId: string;
  folderName: string;
  code: string;
  title: string;
  createdAt: string;
}

export interface SubscriptionDto {
  id: string;
  sharedFolderId: string;
  folderId: string;
  title: string;
  publishedBy: string; // email of the publisher
  documentCount: number;
  subscribedAt: string;
}

// Base32 without the visually-confusing characters (0/O, 1/I/L). 8 chars
// from this alphabet = ~30 bits of entropy — comfortably unguessable
// even at scale (the unique index on `code` makes collisions cheap to
// detect and retry).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

@Injectable()
export class SharedFoldersService {
  private readonly log = new Logger(SharedFoldersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Publish a folder under a new share code. Re-publishing rotates the
   * code — old codes immediately stop resolving. System folders (Inbox /
   * Trash) are not publishable.
   */
  async publish(
    tenantId: string,
    userId: string,
    folderId: string,
    opts: { title?: string } = {},
  ): Promise<SharedFolderDto> {
    const folder = await this.prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder || folder.tenantId !== tenantId) {
      throw new ProblemException({
        status: 404,
        code: 'shared.folder-not-found',
        title: 'Folder not found',
      });
    }
    if (folder.kind !== 'materials') {
      throw new ProblemException({
        status: 400,
        code: 'shared.system-folder',
        title: 'Inbox and Trash cannot be shared',
      });
    }
    const code = await this.uniqueCode();
    // Upsert keeps the existing row for repeat-publish, rotating the code
    // and bumping updatedAt. Soft-deleted rows revive on re-publish.
    const row = await this.prisma.sharedFolder.upsert({
      where: { folderId },
      create: {
        folderId,
        tenantId,
        publishedBy: userId,
        code,
        title: opts.title?.slice(0, 200) ?? folder.name,
      },
      update: {
        code,
        deletedAt: null,
        title: opts.title?.slice(0, 200) ?? folder.name,
        publishedBy: userId,
      },
    });
    this.log.log(
      `share.published folder=${folderId.slice(0, 8)} by=${userId.slice(0, 8)} code=${code}`,
    );
    return toShareDto(row, folder.name);
  }

  async unpublish(tenantId: string, userId: string, folderId: string): Promise<void> {
    const folder = await this.prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder || folder.tenantId !== tenantId) return; // idempotent
    await this.prisma.sharedFolder
      .update({
        where: { folderId },
        data: { deletedAt: new Date() },
      })
      .catch(() => undefined);
    this.log.log(`share.unpublished folder=${folderId.slice(0, 8)} by=${userId.slice(0, 8)}`);
  }

  async getByFolder(tenantId: string, folderId: string): Promise<SharedFolderDto | null> {
    const folder = await this.prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder || folder.tenantId !== tenantId) return null;
    const row = await this.prisma.sharedFolder.findUnique({
      where: { folderId },
    });
    if (!row || row.deletedAt) return null;
    return toShareDto(row, folder.name);
  }

  async subscribeByCode(userId: string, rawCode: string): Promise<SubscriptionDto> {
    const code = rawCode.trim().toUpperCase();
    if (code.length < 4 || code.length > 32) {
      throw new ProblemException({
        status: 400,
        code: 'shared.invalid-code',
        title: 'That code looks malformed',
      });
    }
    const shared = await this.prisma.sharedFolder.findUnique({
      where: { code },
      include: {
        folder: true,
        publisher: { select: { email: true } },
      },
    });
    if (!shared || shared.deletedAt) {
      throw new ProblemException({
        status: 404,
        code: 'shared.code-not-found',
        title: 'No active share with that code',
      });
    }
    if (shared.publishedBy === userId) {
      throw new ProblemException({
        status: 400,
        code: 'shared.self-subscribe',
        title: 'You already own this folder',
      });
    }
    const sub = await this.prisma.folderSubscription.upsert({
      where: { userId_sharedFolderId: { userId, sharedFolderId: shared.id } },
      create: { userId, sharedFolderId: shared.id },
      update: {}, // resubscribing is a no-op
    });
    // Count documents at subscription time for the response — the FE shows
    // this on the success toast.
    const documentCount = await this.prisma.document.count({
      where: { folderId: shared.folderId, deletedAt: null },
    });
    return {
      id: sub.id,
      sharedFolderId: shared.id,
      folderId: shared.folderId,
      title: shared.title ?? shared.folder.name,
      publishedBy: shared.publisher.email,
      documentCount,
      subscribedAt: sub.createdAt.toISOString(),
    };
  }

  async listSubscriptions(userId: string): Promise<SubscriptionDto[]> {
    const rows = await this.prisma.folderSubscription.findMany({
      where: { userId, sharedFolder: { deletedAt: null } },
      include: {
        sharedFolder: {
          include: {
            folder: { include: { _count: { select: { documents: true } } } },
            publisher: { select: { email: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      sharedFolderId: r.sharedFolderId,
      folderId: r.sharedFolder.folderId,
      title: r.sharedFolder.title ?? r.sharedFolder.folder.name,
      publishedBy: r.sharedFolder.publisher.email,
      documentCount: r.sharedFolder.folder._count?.documents ?? 0,
      subscribedAt: r.createdAt.toISOString(),
    }));
  }

  async unsubscribe(userId: string, subscriptionId: string): Promise<void> {
    await this.prisma.folderSubscription
      .deleteMany({ where: { id: subscriptionId, userId } })
      .catch(() => undefined);
  }

  /**
   * Returns the folder ids the user has read-access to via subscription.
   * Retrieval consumers OR this into their tenant-scoped filter so chunks
   * from shared folders are eligible even though they live under another
   * tenant.
   */
  async accessibleFolderIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.folderSubscription.findMany({
      where: { userId, sharedFolder: { deletedAt: null } },
      select: { sharedFolder: { select: { folderId: true } } },
    });
    return rows.map((r) => r.sharedFolder.folderId);
  }

  private async uniqueCode(): Promise<string> {
    // Random 8-char base32 — collisions on small numbers (<1000 active
    // shares) are essentially impossible, but we still retry a handful of
    // times so a freak collision doesn't 500 the caller.
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = generateCode();
      const taken = await this.prisma.sharedFolder.findUnique({
        where: { code: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    throw new ProblemException({
      status: 500,
      code: 'shared.code-collision',
      title: 'Could not allocate a unique share code',
    });
  }
}

function toShareDto(
  row: {
    id: string;
    folderId: string;
    code: string;
    title: string | null;
    createdAt: Date;
  },
  fallbackTitle: string,
): SharedFolderDto {
  return {
    id: row.id,
    folderId: row.folderId,
    folderName: fallbackTitle,
    code: row.code,
    title: row.title ?? fallbackTitle,
    createdAt: row.createdAt.toISOString(),
  };
}
