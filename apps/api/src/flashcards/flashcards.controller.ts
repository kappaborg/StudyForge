import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { CoursesService } from '../common/courses.service';
import { ProblemException } from '../common/problem';
import { enforceBudget } from '../budget/budget-guard';
import { BudgetService } from '../budget/budget.service';
import { isUuid } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';
import { SharedFoldersService } from '../shared-folders/shared-folders.service';
import { ArtifactCacheService } from '../sharing/artifact-cache.service';
import { StreaksService } from '../streaks/streaks.service';
import { SrsService } from './srs.service';

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

class ManualFlashcardDto {
  @IsString() @MaxLength(2000) front!: string;
  @IsString() @MaxLength(2000) back!: string;
  @IsOptional() @IsString() folderId?: string;
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
    private readonly srs: SrsService,
    private readonly courses: CoursesService,
    private readonly shared: SharedFoldersService,
    private readonly streaks: StreaksService,
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
    const allowedFolderIds = await this.shared.accessibleFolderIds(user.userId);
    const body = {
      tenant_id: user.tenantId,
      user_id: user.userId,
      course_id: retrievalCourseId,
      folder_id: retrievalFolderId,
      ...(dto.chapters && dto.chapters.length > 0 ? { chapters: dto.chapters } : {}),
      ...(allowedFolderIds.length > 0 ? { allowed_folder_ids: allowedFolderIds } : {}),
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

  private async ensureCourse(
    tenantId: string,
    userId: string,
    explicitCourseId?: string,
  ): Promise<string> {
    // Userid touched here so dependents don't have to thread it through;
    // tenant scoping lives in CoursesService.
    void userId;
    return this.courses.ensureForTenant(tenantId, explicitCourseId);
  }

  // ── Manual save (Ask → flashcard from selection) ─────────────────────────

  @Post('flashcards/manual')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Save a hand-crafted flashcard (typically from a "highlight → flashcard" selection). Appends to a per-folder "Saved" deck, creating it if needed.',
  })
  async manualSave(
    @CurrentUser() user: AuthContext,
    @Body() dto: ManualFlashcardDto,
  ): Promise<{ flashcardId: string; deckId: string }> {
    const front = dto.front.trim();
    const back = dto.back.trim();
    if (front.length === 0 || back.length === 0) {
      throw new ProblemException({
        status: 400,
        code: 'flashcards.invalid',
        title: 'Front and back are required',
      });
    }
    // Personal-flow artifacts persist to the per-tenant Inbox course
    // (same convention as the generator). The folder context is for the
    // deck title only — there's no hard folder→course mapping yet, so we
    // group "Saved" decks per folder by suffixing the deck title.
    const courseId = await this.ensureCourse(user.tenantId, user.userId);
    const folderName = dto.folderId && isUuid(dto.folderId)
      ? await this.folderName(user.tenantId, dto.folderId)
      : null;
    const deckTitle = folderName ? `Saved · ${folderName}` : 'Saved cards';

    let deck = await this.prisma.flashcardDeck.findFirst({
      where: { courseId, title: deckTitle, deletedAt: null },
    });
    if (!deck) {
      deck = await this.prisma.flashcardDeck.create({
        data: { courseId, title: deckTitle },
      });
    }
    const card = await this.prisma.flashcard.create({
      data: { deckId: deck.id, front, back, citationCount: 0 },
    });
    return { flashcardId: card.id, deckId: deck.id };
  }

  private async folderName(tenantId: string, folderId: string): Promise<string | null> {
    const folder = await this.prisma.folder.findFirst({
      where: { id: folderId, tenantId },
      select: { name: true },
    });
    return folder?.name ?? null;
  }

  // ── SRS (spaced repetition) ──────────────────────────────────────────────

  @Get('flashcards/due')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'List flashcards ready for review now (mix of due-reviews and untouched new cards).',
  })
  async due(
    @CurrentUser() user: AuthContext,
    @Query('limit') limitParam = '20',
  ) {
    const limit = Math.min(100, Math.max(1, Number.parseInt(limitParam, 10) || 20));
    const cards = await this.srs.dueCards(user.tenantId, user.userId, limit);
    return { cards };
  }

  @Get('flashcards/review-stats')
  @HttpCode(200)
  @ApiOperation({ summary: 'Counts: due now / today / this week, total, reviewed today.' })
  async reviewStats(@CurrentUser() user: AuthContext) {
    return this.srs.stats(user.tenantId, user.userId);
  }

  @Post('flashcards/:id/review')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Record an SM-2 review answer (quality 0..5). Returns the new schedule for the card.',
  })
  async review(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { quality: number },
  ) {
    if (typeof body?.quality !== 'number') {
      throw new ProblemException({
        status: 400,
        code: 'srs.missing-quality',
        title: 'Missing review quality (0..5)',
      });
    }
    const result = await this.srs.review(user.tenantId, user.userId, id, body.quality);
    // Streak credit on every review. Idempotent per-day; subsequent
    // reviews same day are no-ops at the streak layer.
    void this.streaks.recordActivity(user.userId).catch(() => undefined);
    return result;
  }
}
