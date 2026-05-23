import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsArray, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { ProblemException } from '../common/problem';
import { enforceBudget } from '../budget/budget-guard';
import { BudgetService } from '../budget/budget.service';
import { isUuid } from '../common/uuid';
import { LtiService } from '../lti/lti.service';
import { nextMastery, type MasteryMap } from '../progress/bkt';
import { PrismaService } from '../prisma/prisma.service';
import { ArtifactCacheService } from '../sharing/artifact-cache.service';

class GenerateQuizDto {
  @IsOptional() @IsString() courseId?: string;
  @IsOptional() @IsString() folderId?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) chapters?: number[];
  @IsOptional() @IsString() @MaxLength(400) query?: string;
  @IsOptional() @IsInt() @Min(1) @Max(20) itemCount?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) difficulty?: number;
}

class SubmitQuizDto {
  @IsObject() responses!: Record<string, number>;
  @IsOptional() @IsInt() @Min(0) durationSec?: number;
}

interface QuizItemDto {
  id: string;
  prompt: string;
  options: string[];
  // ``correctIndex`` is omitted from list/get responses; only revealed in
  // submit feedback. (The worker returns it, the API hides it on read.)
  rationale?: string;
  citations: Array<{ chunkId: string; docId: string; page: number | null; score: number }>;
}

interface QuizDto {
  id: string;
  title: string;
  items: QuizItemDto[];
}

interface SubmitFeedbackDto {
  attemptId: string;
  score: number;
  perItem: Array<{
    itemId: string;
    correct: boolean;
    selectedIndex: number;
    correctIndex: number;
    rationale: string;
  }>;
}

const AI_WORKER_URL = process.env['AI_WORKER_URL'] ?? 'http://localhost:8001';
const DEMO_COURSE_ID = '00000000-0000-0000-0000-00000000c0c0';

interface WorkerQuizItem {
  prompt: string;
  options: string[];
  correct_index: number;
  rationale: string;
  difficulty: number;
  citations: Array<{ chunk_id: string; doc_id: string; page: number | null; slide: number | null; score: number }>;
}

@ApiTags('quizzes')
@Controller()
export class QuizzesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ArtifactCacheService,
    private readonly budget: BudgetService,
    private readonly lti: LtiService,
  ) {}

  @Post('quizzes/generate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate an MCQ quiz from materials, with citations' })
  async generate(@CurrentUser() user: AuthContext, @Body() dto: GenerateQuizDto): Promise<QuizDto> {
    await enforceBudget(this.budget, user.tenantId);
    const persistCourseId = await this.ensureCourse(user.tenantId, dto.courseId);

    // Course-shared artifact cache: reuse a quiz from a peer course that
    // has the same content hash.
    const donor = await this.cache.maybeShareFrom(user.tenantId, persistCourseId);
    if (donor) {
      const canonical = await this.prisma.quiz.findFirst({
        where: { courseId: donor.canonicalCourseId, deletedAt: null },
        include: { items: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });
      if (canonical) {
        return {
          id: canonical.id,
          title: canonical.title,
          items: canonical.items.map((row) => {
            const payload = row.payload as {
              options?: string[];
              citations?: WorkerQuizItem['citations'];
            };
            return {
              id: row.id,
              prompt: row.prompt,
              options: payload.options ?? [],
              citations: (payload.citations ?? []).map((c) => ({
                chunkId: c.chunk_id,
                docId: c.doc_id,
                page: c.page,
                score: c.score,
              })),
            };
          }),
        };
      }
    }

    const retrievalCourseId = isUuid(dto.courseId) ? dto.courseId : null;
    const retrievalFolderId = isUuid(dto.folderId) ? dto.folderId : null;
    const body = {
      tenant_id: user.tenantId,
      user_id: user.userId,
      course_id: retrievalCourseId,
      folder_id: retrievalFolderId,
      ...(dto.chapters && dto.chapters.length > 0 ? { chapters: dto.chapters } : {}),
      query: dto.query ?? '',
      item_count: dto.itemCount ?? 6,
      difficulty: dto.difficulty ?? 50,
    };
    const res = await fetch(`${AI_WORKER_URL}/v1/quizzes/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new ProblemException({
        status: 502,
        code: 'quizzes.upstream-failed',
        title: 'Quiz pipeline failed',
        detail,
      });
    }
    const json = (await res.json()) as { course_id: string; title: string; items: WorkerQuizItem[] };

    // Best-effort concept tagging: scan the course's concepts and stamp
    // any quiz item whose prompt/rationale text contains a concept label.
    // This is the signal Student Progress (P2-7) uses to update mastery.
    const concepts = await this.prisma.concept.findMany({
      where: { courseId: persistCourseId },
      select: { id: true, label: true },
    });
    const matchConcept = (text: string): string | null => {
      const haystack = text.toLowerCase();
      let best: { id: string; len: number } | null = null;
      for (const c of concepts) {
        const lbl = c.label.toLowerCase();
        if (lbl.length < 4) continue;
        if (haystack.includes(lbl) && (!best || lbl.length > best.len)) {
          best = { id: c.id, len: lbl.length };
        }
      }
      return best?.id ?? null;
    };

    const quiz = await this.prisma.quiz.create({
      data: {
        courseId: persistCourseId,
        title: json.title,
        difficulty: dto.difficulty ?? 50,
        items: {
          create: json.items.map((item) => ({
            kind: 'mcq',
            prompt: item.prompt,
            payload: {
              options: item.options,
              correctIndex: item.correct_index,
              citations: item.citations,
            },
            rationale: item.rationale,
            difficulty: item.difficulty,
            conceptId: matchConcept(`${item.prompt} ${item.rationale}`),
          })),
        },
      },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });

    await this.cache.registerCanonical(user.tenantId, persistCourseId);

    return {
      id: quiz.id,
      title: quiz.title,
      items: quiz.items.map((row) => {
        const payload = row.payload as {
          options?: string[];
          citations?: WorkerQuizItem['citations'];
        };
        return {
          id: row.id,
          prompt: row.prompt,
          options: payload.options ?? [],
          citations: (payload.citations ?? []).map((c) => ({
            chunkId: c.chunk_id,
            docId: c.doc_id,
            page: c.page,
            score: c.score,
          })),
        };
      }),
    };
  }

  @Get('courses/:courseId/quizzes')
  @HttpCode(200)
  @ApiOperation({ summary: 'List quizzes for a course' })
  async list(
    @CurrentUser() user: AuthContext,
    @Param('courseId') courseId: string,
  ): Promise<{ quizzes: Array<{ id: string; title: string; itemCount: number; createdAt: string }> }> {
    const resolved = await this.ensureCourse(user.tenantId, courseId);
    const quizzes = await this.prisma.quiz.findMany({
      where: { courseId: resolved, deletedAt: null },
      include: { _count: { select: { items: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      quizzes: quizzes.map((q) => ({
        id: q.id,
        title: q.title,
        itemCount: q._count.items,
        createdAt: q.createdAt.toISOString(),
      })),
    };
  }

  @Get('quizzes/:quizId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get a quiz with its questions (without correct answers)' })
  async getQuiz(@CurrentUser() user: AuthContext, @Param('quizId') quizId: string): Promise<QuizDto> {
    if (!isUuid(quizId)) {
      throw new ProblemException({ status: 404, code: 'quizzes.not-found', title: 'Quiz not found' });
    }
    const quiz = await this.prisma.quiz.findFirst({
      where: { id: quizId, deletedAt: null, course: { tenantId: user.tenantId } },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (!quiz) {
      throw new ProblemException({ status: 404, code: 'quizzes.not-found', title: 'Quiz not found' });
    }
    return {
      id: quiz.id,
      title: quiz.title,
      items: quiz.items.map((row) => {
        const payload = row.payload as { options?: string[]; citations?: WorkerQuizItem['citations'] };
        return {
          id: row.id,
          prompt: row.prompt,
          options: payload.options ?? [],
          citations: (payload.citations ?? []).map((c) => ({
            chunkId: c.chunk_id,
            docId: c.doc_id,
            page: c.page,
            score: c.score,
          })),
        };
      }),
    };
  }

  @Post('quizzes/:quizId/submit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit answers; returns per-item correctness + rationale' })
  async submit(
    @CurrentUser() user: AuthContext,
    @Param('quizId') quizId: string,
    @Body() dto: SubmitQuizDto,
  ): Promise<SubmitFeedbackDto> {
    if (!isUuid(quizId)) {
      throw new ProblemException({ status: 404, code: 'quizzes.not-found', title: 'Quiz not found' });
    }
    const quiz = await this.prisma.quiz.findFirst({
      where: { id: quizId, deletedAt: null, course: { tenantId: user.tenantId } },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!quiz) {
      throw new ProblemException({ status: 404, code: 'quizzes.not-found', title: 'Quiz not found' });
    }

    const perItem: SubmitFeedbackDto['perItem'] = [];
    let correctCount = 0;
    for (const item of quiz.items) {
      const payload = item.payload as { correctIndex?: number };
      const correctIndex = payload.correctIndex ?? 0;
      const selectedIndex = dto.responses[item.id] ?? -1;
      const correct = selectedIndex === correctIndex;
      if (correct) correctCount++;
      perItem.push({
        itemId: item.id,
        correct,
        selectedIndex,
        correctIndex,
        rationale: item.rationale,
      });
    }
    const score = quiz.items.length === 0 ? 0 : correctCount / quiz.items.length;

    const attempt = await this.prisma.quizAttempt.create({
      data: {
        userId: user.userId,
        quizId,
        state: 'submitted',
        score,
        responses: dto.responses,
        submittedAt: new Date(),
        durationSec: dto.durationSec ?? null,
      },
    });

    // BKT-lite mastery update. We touch the per-(user, course) StudentModel
    // and run one update per item that has a conceptId tag. Items without
    // a tag are skipped — the quiz still grades the same.
    await this.updateMastery(user.tenantId, user.userId, quiz.courseId, quiz.items, perItem);

    // LTI grade passback: if the user came in via LTI and the platform
    // attached a lineitems URL, push the score back. Stubbed in dev (logs
    // only) until the tool key is registered with the LMS.
    const ltiLineitems = process.env['LTI_LINEITEMS_URL'];
    if (ltiLineitems) {
      void this.lti
        .sendGrade({
          lineitemsUrl: ltiLineitems,
          userId: user.userId,
          scoreGiven: score,
          scoreMaximum: 1,
          activityProgress: 'Completed',
          gradingProgress: 'FullyGraded',
        })
        .catch(() => undefined);
    }

    return { attemptId: attempt.id, score, perItem };
  }

  private async updateMastery(
    tenantId: string,
    userId: string,
    courseId: string,
    items: Array<{ id: string; conceptId: string | null }>,
    perItem: SubmitFeedbackDto['perItem'],
  ): Promise<void> {
    const tagged = items.filter((i): i is { id: string; conceptId: string } => Boolean(i.conceptId));
    if (tagged.length === 0) return;
    const correctById = new Map(perItem.map((p) => [p.itemId, p.correct] as const));

    const existing = await this.prisma.studentModel.findFirst({
      where: { tenantId, userId, courseId },
    });
    const map: MasteryMap = (existing?.mastery as MasteryMap | undefined) ?? {};
    const now = new Date();
    for (const item of tagged) {
      const correct = correctById.get(item.id) ?? false;
      map[item.conceptId] = nextMastery(map[item.conceptId], correct, now);
    }
    // Cast through ``unknown`` — Prisma's JSON input type is structural and
    // doesn't accept our record-shaped MasteryMap directly.
    const payload = map as unknown as Prisma.InputJsonValue;
    if (existing) {
      await this.prisma.studentModel.update({
        where: { id: existing.id },
        data: { mastery: payload },
      });
    } else {
      await this.prisma.studentModel.create({
        data: { tenantId, userId, courseId, mastery: payload },
      });
    }
  }

  private async ensureCourse(tenantId: string, explicitCourseId?: string): Promise<string> {
    if (isUuid(explicitCourseId)) {
      const existing = await this.prisma.course.findFirst({
        where: { id: explicitCourseId, tenantId },
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
