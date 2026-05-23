import { Controller, Get, HttpCode, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { isUuid } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';

interface DiffSection<T> {
  added: T[];
  removed: T[];
  unchanged: number;
}

interface CourseDiffDto {
  courseId: string;
  flashcards: DiffSection<{ front: string; back: string }> & { hasPrior: boolean };
  quizzes: DiffSection<{ prompt: string }> & { hasPrior: boolean };
  roadmaps: DiffSection<{ weekIndex: number; title: string }> & { hasPrior: boolean };
  concepts: DiffSection<{ label: string }> & { hasPrior: boolean };
}

const DEMO_COURSE_ID = '00000000-0000-0000-0000-00000000c0c0';

@ApiTags('diff')
@Controller()
export class DiffController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('courses/:courseId/diff')
  @HttpCode(200)
  @ApiOperation({ summary: 'Diff between current and previous artifacts for a course' })
  async diff(
    @CurrentUser() user: AuthContext,
    @Param('courseId') courseId: string,
  ): Promise<CourseDiffDto> {
    const resolved = await this.resolveCourse(user.tenantId, courseId);
    const [flashcards, quizzes, roadmaps, concepts] = await Promise.all([
      this.flashcardsDiff(resolved),
      this.quizzesDiff(resolved),
      this.roadmapsDiff(resolved),
      // Concepts don't have an explicit version history — the extract
      // handler wipes the table on each run. Returning a single-section
      // diff with empty added/removed keeps the response shape stable
      // for the FE; the field is reserved for the regeneration log we'll
      // add later.
      Promise.resolve({ added: [], removed: [], unchanged: 0, hasPrior: false } as DiffSection<{ label: string }> & { hasPrior: boolean }),
    ]);
    void concepts;
    return {
      courseId: resolved,
      flashcards,
      quizzes,
      roadmaps,
      concepts: { added: [], removed: [], unchanged: 0, hasPrior: false },
    };
  }

  private async flashcardsDiff(
    courseId: string,
  ): Promise<DiffSection<{ front: string; back: string }> & { hasPrior: boolean }> {
    const decks = await this.prisma.flashcardDeck.findMany({
      where: { courseId, deletedAt: null },
      include: { flashcards: { where: { deletedAt: null } } },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    const current = decks[0];
    const prior = decks[1];
    if (!current || !prior) {
      return { added: [], removed: [], unchanged: 0, hasPrior: false };
    }
    return diffSets(
      current.flashcards.map((c) => ({ key: `${c.front}\n${c.back}`, item: { front: c.front, back: c.back } })),
      prior.flashcards.map((c) => ({ key: `${c.front}\n${c.back}`, item: { front: c.front, back: c.back } })),
    );
  }

  private async quizzesDiff(
    courseId: string,
  ): Promise<DiffSection<{ prompt: string }> & { hasPrior: boolean }> {
    const quizzes = await this.prisma.quiz.findMany({
      where: { courseId, deletedAt: null },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    const current = quizzes[0];
    const prior = quizzes[1];
    if (!current || !prior) {
      return { added: [], removed: [], unchanged: 0, hasPrior: false };
    }
    return diffSets(
      current.items.map((q) => ({ key: q.prompt, item: { prompt: q.prompt } })),
      prior.items.map((q) => ({ key: q.prompt, item: { prompt: q.prompt } })),
    );
  }

  private async roadmapsDiff(
    courseId: string,
  ): Promise<DiffSection<{ weekIndex: number; title: string }> & { hasPrior: boolean }> {
    const roadmaps = await this.prisma.roadmap.findMany({
      where: { courseId, deletedAt: null },
      include: { milestones: true },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    const current = roadmaps[0];
    const prior = roadmaps[1];
    if (!current || !prior) {
      return { added: [], removed: [], unchanged: 0, hasPrior: false };
    }
    return diffSets(
      current.milestones.map((m) => ({
        key: `${m.weekIndex}|${m.title}`,
        item: { weekIndex: m.weekIndex, title: m.title },
      })),
      prior.milestones.map((m) => ({
        key: `${m.weekIndex}|${m.title}`,
        item: { weekIndex: m.weekIndex, title: m.title },
      })),
    );
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

function diffSets<T>(
  current: Array<{ key: string; item: T }>,
  prior: Array<{ key: string; item: T }>,
): DiffSection<T> & { hasPrior: boolean } {
  const priorKeys = new Set(prior.map((p) => p.key));
  const currentKeys = new Set(current.map((c) => c.key));
  const added = current.filter((c) => !priorKeys.has(c.key)).map((c) => c.item);
  const removed = prior.filter((p) => !currentKeys.has(p.key)).map((p) => p.item);
  const unchanged = current.filter((c) => priorKeys.has(c.key)).length;
  return { added, removed, unchanged, hasPrior: true };
}
