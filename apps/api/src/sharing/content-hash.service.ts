import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Computes ``Course.contentHash`` = sha256 of the sorted distinct
 * ``DocumentVersion.contentSha256`` set for a course.
 *
 * Sharing semantics: two courses with the SAME composite hash share
 * generated artifacts (flashcards / quizzes / roadmap / concepts). The
 * canonical course owns the artifacts; followers get them by setting
 * ``Course.sharedFromCourseId``.
 */
@Injectable()
export class ContentHashService {
  constructor(private readonly prisma: PrismaService) {}

  async forCourse(tenantId: string, courseId: string): Promise<string | null> {
    // Documents directly attached to the course. Latest version per doc.
    const documents = await this.prisma.document.findMany({
      where: { tenantId, courseId, deletedAt: null },
      select: {
        versions: {
          select: { contentSha256: true, versionNumber: true },
          orderBy: { versionNumber: 'desc' },
          take: 1,
        },
      },
    });
    let hashes = documents
      .map((d) => d.versions[0]?.contentSha256)
      .filter((h): h is string => Boolean(h));

    // Inbox-style courses have no directly-attached documents; fall back to
    // the tenant's untagged uploads so the shared-artifact path still
    // works on the demo flow.
    if (hashes.length === 0) {
      const untagged = await this.prisma.document.findMany({
        where: { tenantId, courseId: null, deletedAt: null },
        select: {
          versions: {
            select: { contentSha256: true, versionNumber: true },
            orderBy: { versionNumber: 'desc' },
            take: 1,
          },
        },
      });
      hashes = untagged
        .map((d) => d.versions[0]?.contentSha256)
        .filter((h): h is string => Boolean(h));
    }

    if (hashes.length === 0) return null;
    const sorted = [...new Set(hashes)].sort();
    return createHash('sha256').update(sorted.join('|')).digest('hex');
  }
}
