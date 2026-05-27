import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isUuid } from './uuid';

/**
 * Shared resolver for the personal-flow "Inbox" course.
 *
 * Each tenant gets exactly one Inbox course (find-or-create by ``tenantId``
 * + ``title='Inbox'``). Replaces the older pattern where every controller
 * had its own ``ensureCourse`` that pointed at a single hardcoded
 * ``DEMO_COURSE_ID`` — that pattern silently shared the Inbox across all
 * tenants, so every tenant after the first lost access to artifacts they
 * created via the "no folder picked" path.
 *
 * Honors an explicit courseId when the caller passes a valid UUID owned by
 * the tenant; falls back to Inbox otherwise.
 */
@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureForTenant(
    tenantId: string,
    explicitCourseId?: string,
  ): Promise<string> {
    if (isUuid(explicitCourseId)) {
      const existing = await this.prisma.course.findFirst({
        where: { id: explicitCourseId, tenantId },
      });
      if (existing) return existing.id;
    }
    return this.ensureInbox(tenantId);
  }

  async ensureInbox(tenantId: string): Promise<string> {
    const existing = await this.prisma.course.findFirst({
      where: { tenantId, title: 'Inbox', deletedAt: null },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await this.prisma.course.create({
      data: { tenantId, title: 'Inbox' },
    });
    return created.id;
  }
}
