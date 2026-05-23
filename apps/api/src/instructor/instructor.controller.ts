import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { PrismaService } from '../prisma/prisma.service';
import type { MasteryMap } from '../progress/bkt';

interface CourseRow {
  id: string;
  title: string;
  studentCount: number;
  documentCount: number;
  deckCount: number;
  quizCount: number;
  avgMastery: number | null;
  conceptCount: number;
}

interface AbuseRow {
  id: string;
  s3Key: string;
  state: string;
  flags: string[];
  createdAt: string;
  userId: string;
}

/**
 * Instructor portal. Phase 3 scope: tenant-level aggregates + safety
 * findings list. Real RBAC (only ``instructor`` enrollment role sees this)
 * lands in Phase 4 with OAuth + LTI; today every dev user is "instructor"
 * for their own tenant.
 */
@ApiTags('instructor')
@Controller('instructor')
export class InstructorController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('overview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Tenant-wide totals for the instructor portal' })
  async overview(@CurrentUser() user: AuthContext): Promise<{
    courses: number;
    documents: number;
    students: number;
    quizAttempts: number;
    avgScore: number | null;
    abusePending: number;
  }> {
    const tenantId = user.tenantId;
    const [courseCount, documentCount, studentCount, attempts, abusePending] =
      await Promise.all([
        this.prisma.course.count({ where: { tenantId, deletedAt: null } }),
        this.prisma.document.count({ where: { tenantId, deletedAt: null } }),
        this.prisma.user.count({ where: { tenantId } }),
        this.prisma.quizAttempt.findMany({
          where: { quiz: { course: { tenantId } }, score: { not: null } },
          select: { score: true },
        }),
        this.prisma.uploadBatch.count({
          where: { tenantId, safetyFlags: { isEmpty: false } },
        }),
      ]);
    const avgScore =
      attempts.length === 0
        ? null
        : attempts.reduce((acc, a) => acc + (a.score ?? 0), 0) / attempts.length;
    return {
      courses: courseCount,
      documents: documentCount,
      students: studentCount,
      quizAttempts: attempts.length,
      avgScore,
      abusePending,
    };
  }

  @Get('courses')
  @HttpCode(200)
  @ApiOperation({ summary: 'Per-course aggregates' })
  async courses(@CurrentUser() user: AuthContext): Promise<{ courses: CourseRow[] }> {
    const tenantId = user.tenantId;
    const courses = await this.prisma.course.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            enrollments: true,
            documents: true,
            flashcardDecks: true,
            quizzes: true,
            concepts: true,
          },
        },
      },
    });
    // Compute average mastery per course by walking StudentModel rows.
    const studentModels = await this.prisma.studentModel.findMany({
      where: { tenantId },
      select: { courseId: true, mastery: true },
    });
    const masteryByCourse = new Map<string, number[]>();
    for (const sm of studentModels) {
      const map = (sm.mastery as unknown as MasteryMap | undefined) ?? {};
      const touched = Object.values(map).filter((m) => m.attempts > 0);
      if (touched.length === 0) continue;
      const avg = touched.reduce((a, b) => a + b.mastery, 0) / touched.length;
      const arr = masteryByCourse.get(sm.courseId) ?? [];
      arr.push(avg);
      masteryByCourse.set(sm.courseId, arr);
    }
    const rows: CourseRow[] = courses.map((c) => {
      const masteries = masteryByCourse.get(c.id) ?? [];
      const avgMastery =
        masteries.length === 0
          ? null
          : masteries.reduce((a, b) => a + b, 0) / masteries.length;
      return {
        id: c.id,
        title: c.title,
        studentCount: c._count.enrollments,
        documentCount: c._count.documents,
        deckCount: c._count.flashcardDecks,
        quizCount: c._count.quizzes,
        avgMastery,
        conceptCount: c._count.concepts,
      };
    });
    return { courses: rows };
  }

  @Get('abuse')
  @HttpCode(200)
  @ApiOperation({ summary: 'Recent uploads flagged by the safety pipeline' })
  async abuse(@CurrentUser() user: AuthContext): Promise<{ items: AbuseRow[] }> {
    const tenantId = user.tenantId;
    const rows = await this.prisma.uploadBatch.findMany({
      where: { tenantId, safetyFlags: { isEmpty: false } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        s3Key: true,
        state: true,
        safetyFlags: true,
        createdAt: true,
        userId: true,
      },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        s3Key: r.s3Key,
        state: r.state,
        flags: r.safetyFlags,
        createdAt: r.createdAt.toISOString(),
        userId: r.userId,
      })),
    };
  }
}
