import { Controller, Get, HttpCode, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { CoursesService } from '../common/courses.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
  ) {}

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

  @Get('mastery')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Aggregated per-concept mastery across all the user’s courses. ?weakest=N returns the N lowest-mastery rows for adaptive practice.',
  })
  async aggregate(
    @CurrentUser() user: AuthContext,
    @Query('weakest') weakestParam?: string,
  ): Promise<{
    rows: Array<MasteryRowDto & { courseId: string; courseTitle: string }>;
  }> {
    // One pass: join all student models for this user with the matching
    // concepts. We do it in app code because the mastery payload is JSON
    // and the concept join is on conceptId stringly-typed inside the JSON.
    const [models, allConcepts, courses] = await Promise.all([
      this.prisma.studentModel.findMany({
        where: { tenantId: user.tenantId, userId: user.userId },
      }),
      this.prisma.concept.findMany({
        where: { course: { tenantId: user.tenantId } },
        select: { id: true, label: true, courseId: true },
      }),
      this.prisma.course.findMany({
        where: { tenantId: user.tenantId, deletedAt: null },
        select: { id: true, title: true },
      }),
    ]);

    const labelById = new Map(allConcepts.map((c) => [c.id, c] as const));
    const courseTitleById = new Map(courses.map((c) => [c.id, c.title] as const));

    const rows: Array<MasteryRowDto & { courseId: string; courseTitle: string }> = [];
    for (const model of models) {
      const map = (model.mastery as unknown as MasteryMap | undefined) ?? {};
      for (const [conceptId, entry] of Object.entries(map)) {
        const concept = labelById.get(conceptId);
        // Surface orphan rows too — students sometimes notice their stats
        // include a deleted concept and ask what happened.
        rows.push({
          conceptId,
          label: concept?.label ?? '(deleted concept)',
          mastery: entry.mastery,
          attempts: entry.attempts,
          correct: entry.correct,
          lastSeenAt: entry.lastSeenAt,
          courseId: model.courseId,
          courseTitle: courseTitleById.get(model.courseId) ?? 'Inbox',
        });
      }
    }

    const weakest = weakestParam ? Math.min(50, Math.max(1, Number.parseInt(weakestParam, 10) || 0)) : null;
    if (weakest) {
      // Prefer concepts that have at least one attempt — a 0% on something
      // you never tried is not a useful "weakness" signal. If we don't have
      // enough attempted concepts, fall back to never-attempted ones.
      const attempted = rows.filter((r) => r.attempts > 0).sort((a, b) => a.mastery - b.mastery);
      const sliced = attempted.slice(0, weakest);
      if (sliced.length < weakest) {
        const untried = rows.filter((r) => r.attempts === 0).slice(0, weakest - sliced.length);
        sliced.push(...untried);
      }
      return { rows: sliced };
    }

    rows.sort((a, b) => a.mastery - b.mastery);
    return { rows };
  }

  private async resolveCourse(tenantId: string, explicit?: string): Promise<string> {
    return this.courses.ensureForTenant(tenantId, explicit);
  }
}
