import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ContentHashService } from './content-hash.service';

export type ArtifactKind = 'flashcards' | 'quizzes' | 'roadmaps' | 'concepts';

/**
 * Course-shared artifact cache.
 *
 * Two courses with the same ``Course.contentHash`` share generated
 * artifacts. The first course to generate for a given hash becomes the
 * canonical owner; later courses with the same hash are linked via
 * ``Course.sharedFromCourseId`` and read artifacts from the canonical
 * course instead of regenerating.
 *
 * Callers wrap their generate handler with ``maybeShareFrom`` to short-
 * circuit when a canonical donor exists, and ``registerCanonical`` after
 * a successful generation to make the current course discoverable.
 */
@Injectable()
export class ArtifactCacheService {
  private readonly log = new Logger(ArtifactCacheService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contentHash: ContentHashService,
  ) {}

  /** If a canonical course exists for the current content set, link the
   *  caller's course to it and return the canonical id; null otherwise. */
  async maybeShareFrom(
    tenantId: string,
    courseId: string,
  ): Promise<{ canonicalCourseId: string; contentHash: string } | null> {
    const hash = await this.contentHash.forCourse(tenantId, courseId);
    if (!hash) return null;

    // Self-canonical: already the canonical donor for this hash.
    const self = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { sharedFromCourseId: true, contentHash: true },
    });
    const shared = await this.prisma.sharedArtifact.findUnique({
      where: { contentHash: hash },
      select: { canonicalCourseId: true },
    });
    if (!shared) return null;
    if (shared.canonicalCourseId === courseId) return null;

    // Link the caller course to the canonical donor. Persist the hash on
    // the caller too so future calls don't have to recompute.
    if (self?.contentHash !== hash || self?.sharedFromCourseId !== shared.canonicalCourseId) {
      await this.prisma.course.update({
        where: { id: courseId },
        data: { contentHash: hash, sharedFromCourseId: shared.canonicalCourseId },
      });
      this.log.log(
        `artifact-cache.linked course=${courseId} → canonical=${shared.canonicalCourseId} hash=${hash.slice(0, 8)}`,
      );
    }
    return { canonicalCourseId: shared.canonicalCourseId, contentHash: hash };
  }

  /** Mark the current course as the canonical owner for its hash. Idempotent. */
  async registerCanonical(tenantId: string, courseId: string): Promise<void> {
    const hash = await this.contentHash.forCourse(tenantId, courseId);
    if (!hash) return;
    const existing = await this.prisma.sharedArtifact.findUnique({
      where: { contentHash: hash },
    });
    if (existing) {
      // Donor already chosen. Update the caller's link.
      if (existing.canonicalCourseId !== courseId) {
        await this.prisma.course.update({
          where: { id: courseId },
          data: { contentHash: hash, sharedFromCourseId: existing.canonicalCourseId },
        });
      }
      return;
    }

    // The course may already own a SharedArtifact row for an older
    // hash (e.g. its document set evolved). ``canonicalCourseId`` is
    // unique, so a naive create() crashes. Upsert by ``canonicalCourseId``
    // updates the row in place when the course already has one.
    const priorByCourse = await this.prisma.sharedArtifact.findUnique({
      where: { canonicalCourseId: courseId },
    });
    if (priorByCourse) {
      await this.prisma.sharedArtifact.update({
        where: { canonicalCourseId: courseId },
        data: { contentHash: hash },
      });
    } else {
      try {
        await this.prisma.sharedArtifact.create({
          data: { contentHash: hash, canonicalCourseId: courseId },
        });
      } catch (err) {
        // Race: another request just created the row for the same hash
        // or course. Treat as success — the canonical link is already
        // there.
        this.log.warn(`artifact-cache.race-on-register course=${courseId}: ${err}`);
      }
    }
    await this.prisma.course.update({
      where: { id: courseId },
      data: { contentHash: hash },
    });
    this.log.log(
      `artifact-cache.registered course=${courseId} hash=${hash.slice(0, 8)} (canonical)`,
    );
  }
}
