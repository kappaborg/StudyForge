import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { ProblemException } from '../common/problem';
import { enforceBudget } from '../budget/budget-guard';
import { BudgetService } from '../budget/budget.service';
import { isUuid } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';
import { ArtifactCacheService } from '../sharing/artifact-cache.service';

class GenerateFlashcardsDto {
  // Accept any non-empty string here; the controller resolves "non-UUID"
  // into the Inbox course rather than rejecting at the boundary so the
  // FE can pass route-segment placeholders like "demo".
  @IsOptional()
  @IsString()
  courseId?: string;

  // Folder-scoped retrieval. When set, only chunks from documents in this
  // folder are eligible — sharpens generation context for a lecture set.
  @IsOptional()
  @IsString()
  folderId?: string;

  // Exam-scope retrieval: union of chapter numbers across the active scope.
  // When set, the worker filters chunks by ``meta.chapter ∈ chapters``.
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  chapters?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(400)
  query?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  deckSize?: number;
}

interface FlashcardCitationDto {
  chunkId: string;
  docId: string;
  page: number | null;
  slide: number | null;
  score: number;
}

interface FlashcardDto {
  id: string;
  front: string;
  back: string;
  citations: FlashcardCitationDto[];
}

interface GenerateFlashcardsResponseDto {
  deckId: string;
  deckTitle: string;
  flashcards: FlashcardDto[];
}

const AI_WORKER_URL = process.env['AI_WORKER_URL'] ?? 'http://localhost:8001';

const DEMO_COURSE_ID = '00000000-0000-0000-0000-00000000c0c0';

@ApiTags('flashcards')
@Controller()
export class FlashcardsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ArtifactCacheService,
    private readonly budget: BudgetService,
  ) {}

  @Post('flashcards/generate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate a flashcard deck from materials, with citations' })
  async generate(
    @CurrentUser() user: AuthContext,
    @Body() dto: GenerateFlashcardsDto,
  ): Promise<GenerateFlashcardsResponseDto> {
    await enforceBudget(this.budget, user.tenantId);
    const courseId = await this.ensureCourse(user.tenantId, user.userId, dto.courseId);

    // Course-shared artifact cache: if some other course with the same
    // content hash already has a deck, link our course to it and return
    // the canonical deck's contents instead of regenerating.
    const donor = await this.cache.maybeShareFrom(user.tenantId, courseId);
    if (donor) {
      const canonical = await this.prisma.flashcardDeck.findFirst({
        where: { courseId: donor.canonicalCourseId, deletedAt: null },
        include: { flashcards: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });
      if (canonical) {
        return {
          deckId: canonical.id,
          deckTitle: canonical.title,
          flashcards: canonical.flashcards.map((row) => ({
            id: row.id,
            front: row.front,
            back: row.back,
            citations: [],
          })),
        };
      }
    }

    // Retrieval is scoped to the *tenant* (broad coverage of all uploads),
    // but persistence is scoped to a course so the user can revisit the
    // deck. When the caller didn't pick a specific UUID course, we file the
    // deck under the per-tenant "Inbox" course but still search broadly.
    const retrievalCourseId = isUuid(dto.courseId) ? dto.courseId : null;
    const retrievalFolderId = isUuid(dto.folderId) ? dto.folderId : null;
    const body = {
      tenant_id: user.tenantId,
      user_id: user.userId,
      course_id: retrievalCourseId,
      folder_id: retrievalFolderId,
      ...(dto.chapters && dto.chapters.length > 0 ? { chapters: dto.chapters } : {}),
      query: dto.query ?? '',
      deck_size: dto.deckSize ?? 12,
    };
    const res = await fetch(`${AI_WORKER_URL}/v1/flashcards/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new ProblemException({
        status: 502,
        code: 'flashcards.upstream-failed',
        title: 'Flashcard pipeline failed',
        detail,
      });
    }
    const json = (await res.json()) as {
      course_id: string;
      deck_title: string;
      flashcards: Array<{
        kind: string;
        front: string;
        back: string;
        citations: Array<{ chunk_id: string; doc_id: string; page: number | null; slide: number | null; score: number }>;
      }>;
    };

    // Persist the deck + cards so the user can revisit it. Citations stay
    // in-memory for now (Citation row schema lives under tutor sessions; a
    // separate FlashcardCitation table comes with the SRS work).
    const deck = await this.prisma.flashcardDeck.create({
      data: {
        courseId,
        title: json.deck_title,
        flashcards: {
          create: json.flashcards.map((card) => ({
            front: card.front,
            back: card.back,
            citationCount: card.citations.length,
          })),
        },
      },
      include: { flashcards: true },
    });

    const flashcards: FlashcardDto[] = deck.flashcards.map((row, i) => ({
      id: row.id,
      front: row.front,
      back: row.back,
      citations: (json.flashcards[i]?.citations ?? []).map((c) => ({
        chunkId: c.chunk_id,
        docId: c.doc_id,
        page: c.page,
        slide: c.slide,
        score: c.score,
      })),
    }));

    // First successful generation for this content set → publish ourselves
    // as the canonical donor so peer courses share this deck.
    await this.cache.registerCanonical(user.tenantId, courseId);

    return { deckId: deck.id, deckTitle: deck.title, flashcards };
  }

  @Get('courses/:courseId/flashcards')
  @HttpCode(200)
  @ApiOperation({ summary: 'List flashcard decks for a course' })
  async list(
    @CurrentUser() user: AuthContext,
    @Param('courseId') courseId: string,
  ): Promise<{ decks: Array<{ id: string; title: string; cardCount: number; createdAt: string }> }> {
    const resolved = await this.ensureCourse(user.tenantId, user.userId, courseId);
    const decks = await this.prisma.flashcardDeck.findMany({
      where: { courseId: resolved, deletedAt: null },
      include: { _count: { select: { flashcards: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      decks: decks.map((d) => ({
        id: d.id,
        title: d.title,
        cardCount: d._count.flashcards,
        createdAt: d.createdAt.toISOString(),
      })),
    };
  }

  @Get('flashcards/decks/:deckId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get a deck with its cards' })
  async getDeck(
    @CurrentUser() user: AuthContext,
    @Param('deckId') deckId: string,
  ): Promise<{ id: string; title: string; flashcards: Array<{ id: string; front: string; back: string; citationCount: number }> }> {
    if (!isUuid(deckId)) {
      throw new ProblemException({
        status: 404,
        code: 'flashcards.not-found',
        title: 'Deck not found',
      });
    }
    const deck = await this.prisma.flashcardDeck.findFirst({
      where: { id: deckId, deletedAt: null, course: { tenantId: user.tenantId } },
      include: { flashcards: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
    });
    if (!deck) {
      throw new ProblemException({
        status: 404,
        code: 'flashcards.not-found',
        title: 'Deck not found',
      });
    }
    return {
      id: deck.id,
      title: deck.title,
      flashcards: deck.flashcards.map((c) => ({
        id: c.id,
        front: c.front,
        back: c.back,
        citationCount: c.citationCount,
      })),
    };
  }

  // Dev convenience: an upload with no explicit courseId still needs a row
  // to associate the deck with, so we lazily create a single "Inbox" course
  // per tenant.
  private async ensureCourse(
    tenantId: string,
    userId: string,
    explicitCourseId?: string,
  ): Promise<string> {
    if (isUuid(explicitCourseId)) {
      const existing = await this.prisma.course.findFirst({
        where: { id: explicitCourseId, tenantId },
      });
      if (existing) return existing.id;
    }
    const inboxId = DEMO_COURSE_ID;
    const inbox = await this.prisma.course.findUnique({ where: { id: inboxId } });
    if (inbox) return inbox.id;
    await this.prisma.course.create({
      data: {
        id: inboxId,
        tenantId,
        title: 'Inbox',
      },
    });
    // Touch `userId` so the linter doesn't flag the unused param; user
    // identity is enforced by tenantId scoping elsewhere.
    void userId;
    return inboxId;
  }
}
