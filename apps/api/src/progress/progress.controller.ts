import { Controller, Get, HttpCode, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { isUuid } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';
import type { MasteryMap } from './bkt';

interface MasteryRowDto {
  conceptId: string;
  label: string;
  mastery: number;
  attempts: number;
  correct: number;
  lastSeenAt: string;
}

const DEMO_COURSE_ID = '00000000-0000-0000-0000-00000000c0c0';

@ApiTags('progress')
@Controller()
export class ProgressController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('courses/:courseId/mastery')
  @HttpCode(200)
  @ApiOperation({ summary: 'Per-concept mastery for the current user' })
  async mastery(
    @CurrentUser() user: AuthContext,
    @Param('courseId') courseId: string,
  ): Promise<{ courseId: string; mastery: MasteryRowDto[] }> {
    const resolved = await this.resolveCourse(user.tenantId, courseId);
    const [model, concepts] = await Promise.all([
      this.prisma.studentModel.findFirst({
        where: { tenantId: user.tenantId, userId: user.userId, courseId: resolved },
      }),
      this.prisma.concept.findMany({
        where: { courseId: resolved },
        select: { id: true, label: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const map = (model?.mastery as MasteryMap | undefined) ?? {};
    const labelById = new Map(concepts.map((c) => [c.id, c.label] as const));

    const rows: MasteryRowDto[] = concepts.map((c) => {
      const entry = map[c.id];
      return {
        conceptId: c.id,
        label: c.label,
        mastery: entry?.mastery ?? 0,
        attempts: entry?.attempts ?? 0,
        correct: entry?.correct ?? 0,
        lastSeenAt: entry?.lastSeenAt ?? '',
      };
    });
    // Surface any "orphan" mastery rows whose concept has been deleted —
    // helps catch stale graph cleanups.
    for (const [conceptId, entry] of Object.entries(map)) {
      if (!labelById.has(conceptId)) {
        rows.push({
          conceptId,
          label: '(deleted concept)',
          mastery: entry.mastery,
          attempts: entry.attempts,
          correct: entry.correct,
          lastSeenAt: entry.lastSeenAt,
        });
      }
    }

    return { courseId: resolved, mastery: rows };
  }

  private async resolveCourse(tenantId: string, explicit?: string): Promise<string> {
    if (isUuid(explicit)) {
      const existing = await this.prisma.course.findFirst({
        where: { id: explicit, tenantId },
      });
      if (existing) return existing.id;
    }
    const inbox = await this.prisma.course.findUnique({ where: { id: DEMO_COURSE_ID } });
    if (inbox) return inbox.id;
    await this.prisma.course.create({
      data: { id: DEMO_COURSE_ID, tenantId, title: 'Inbox' },
    });
    return DEMO_COURSE_ID;
  }
}
