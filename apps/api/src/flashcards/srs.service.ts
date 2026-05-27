import { Injectable, Logger } from '@nestjs/common';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SuperMemo-2 spaced-repetition scheduler.
 *
 * Quality scale (passed to ``review``):
 *   0  total blackout
 *   1  wrong, but felt familiar
 *   2  wrong, but quickly recalled the right answer
 *   3  correct with serious difficulty
 *   4  correct after hesitation
 *   5  perfect
 *
 * The UI uses four buttons (Again / Hard / Good / Easy) mapped to
 * qualities {1, 3, 4, 5}. We never expose the full 0–5 range — too many
 * choices makes reviews slower without measurably improving the model.
 */

export const MIN_EASE = 1.3;
export const STARTING_EASE = 2.5;

export interface ReviewableCard {
  id: string;
  front: string;
  back: string;
  deckId: string;
  deckTitle: string;
  // Review state (null = never reviewed; will be lazy-created on first answer).
  intervalDays: number;
  easeFactor: number;
  reviewCount: number;
  lastReviewedAt: string | null;
}

export interface ReviewStats {
  dueNow: number;
  dueToday: number;
  dueThisWeek: number;
  totalCards: number;
  reviewedToday: number;
}

@Injectable()
export class SrsService {
  private readonly log = new Logger(SrsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cards eligible for review right now, capped at ``limit`` so a session
   * doesn't drown the user. Returns a mix of:
   *   • due reviews (existing rows where ``dueAt <= now``), oldest first
   *   • brand-new cards (no review row yet), filling up to the cap
   *
   * Both queries are scoped to flashcards in decks the user can see
   * (via courses owned by their tenant). This is the only place SRS
   * crosses out of the per-user FlashcardReview rows; the tenant join
   * keeps us from leaking cards across accounts.
   */
  async dueCards(
    tenantId: string,
    userId: string,
    limit = 20,
  ): Promise<ReviewableCard[]> {
    const now = new Date();
    const cap = Math.min(Math.max(limit, 1), 100);

    // 1. Due reviews — existing rows past their dueAt, oldest first.
    const dueReviews = await this.prisma.flashcardReview.findMany({
      where: {
        userId,
        dueAt: { lte: now },
        flashcard: {
          deletedAt: null,
          deck: { deletedAt: null, course: { tenantId } },
        },
      },
      include: { flashcard: { include: { deck: true } } },
      orderBy: { dueAt: 'asc' },
      take: cap,
    });

    const out: ReviewableCard[] = dueReviews.map((r) => ({
      id: r.flashcard.id,
      front: r.flashcard.front,
      back: r.flashcard.back,
      deckId: r.flashcard.deckId,
      deckTitle: r.flashcard.deck.title,
      intervalDays: r.intervalDays,
      easeFactor: r.easeFactor,
      reviewCount: r.reviewCount,
      lastReviewedAt: r.lastReviewedAt?.toISOString() ?? null,
    }));

    if (out.length >= cap) return out;

    // 2. Fill remaining slots with brand-new cards (no review row yet).
    // Excludes anything already in the dueReviews set.
    const seen = new Set(out.map((c) => c.id));
    const fresh = await this.prisma.flashcard.findMany({
      where: {
        deletedAt: null,
        deck: { deletedAt: null, course: { tenantId } },
        reviews: { none: { userId } },
        ...(seen.size > 0 ? { id: { notIn: Array.from(seen) } } : {}),
      },
      include: { deck: true },
      orderBy: { createdAt: 'asc' },
      take: cap - out.length,
    });

    for (const f of fresh) {
      out.push({
        id: f.id,
        front: f.front,
        back: f.back,
        deckId: f.deckId,
        deckTitle: f.deck.title,
        intervalDays: 0,
        easeFactor: STARTING_EASE,
        reviewCount: 0,
        lastReviewedAt: null,
      });
    }

    return out;
  }

  /**
   * Record a review answer and advance the SRS state. Lazy-creates the
   * FlashcardReview row on first call for this (user, card).
   *
   * Returns the new state so the FE can show "next review in N days" and
   * choose the next card from the session queue.
   */
  async review(
    tenantId: string,
    userId: string,
    flashcardId: string,
    quality: number,
  ): Promise<{
    intervalDays: number;
    easeFactor: number;
    dueAt: string;
    reviewCount: number;
    lapsed: boolean;
  }> {
    if (quality < 0 || quality > 5 || !Number.isInteger(quality)) {
      throw new ProblemException({
        status: 400,
        code: 'srs.invalid-quality',
        title: 'Review quality must be an integer 0..5',
      });
    }
    // Ownership check: the card must belong to a deck in a course the user
    // can see. This is the per-card analogue of the tenant filter in dueCards.
    const card = await this.prisma.flashcard.findUnique({
      where: { id: flashcardId },
      include: { deck: { include: { course: true } } },
    });
    if (!card || card.deletedAt || card.deck.course.tenantId !== tenantId) {
      throw new ProblemException({
        status: 404,
        code: 'srs.card-not-found',
        title: 'Flashcard not found',
      });
    }

    const existing = await this.prisma.flashcardReview.findUnique({
      where: { userId_flashcardId: { userId, flashcardId } },
    });

    const prevEase = existing?.easeFactor ?? STARTING_EASE;
    const prevInterval = existing?.intervalDays ?? 0;
    const prevReviewCount = existing?.reviewCount ?? 0;
    const passed = quality >= 3;
    const lapsed = !passed && prevReviewCount > 0;

    const nextEase = updateEase(prevEase, quality);
    const nextInterval = nextIntervalDays(prevInterval, prevReviewCount, nextEase, passed);
    const now = new Date();
    const dueAt = new Date(now.getTime() + nextInterval * 86_400_000);

    const updated = await this.prisma.flashcardReview.upsert({
      where: { userId_flashcardId: { userId, flashcardId } },
      create: {
        userId,
        flashcardId,
        easeFactor: nextEase,
        intervalDays: nextInterval,
        dueAt,
        reviewCount: 1,
        lapseCount: lapsed ? 1 : 0,
        lastQuality: quality,
        lastReviewedAt: now,
      },
      update: {
        easeFactor: nextEase,
        intervalDays: nextInterval,
        dueAt,
        reviewCount: { increment: 1 },
        lapseCount: lapsed ? { increment: 1 } : undefined,
        lastQuality: quality,
        lastReviewedAt: now,
      },
    });

    return {
      intervalDays: updated.intervalDays,
      easeFactor: updated.easeFactor,
      dueAt: updated.dueAt.toISOString(),
      reviewCount: updated.reviewCount,
      lapsed,
    };
  }

  async stats(tenantId: string, userId: string): Promise<ReviewStats> {
    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const endOfWeek = new Date(now.getTime() + 7 * 86_400_000);
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const tenantFlashcardFilter = {
      deletedAt: null,
      deck: { deletedAt: null, course: { tenantId } },
    } as const;

    const [dueNow, dueToday, dueThisWeek, reviewedToday, totalCards, newCards] =
      await Promise.all([
        this.prisma.flashcardReview.count({
          where: { userId, dueAt: { lte: now }, flashcard: tenantFlashcardFilter },
        }),
        this.prisma.flashcardReview.count({
          where: {
            userId,
            dueAt: { lte: endOfDay },
            flashcard: tenantFlashcardFilter,
          },
        }),
        this.prisma.flashcardReview.count({
          where: {
            userId,
            dueAt: { lte: endOfWeek },
            flashcard: tenantFlashcardFilter,
          },
        }),
        this.prisma.flashcardReview.count({
          where: {
            userId,
            lastReviewedAt: { gte: startOfDay },
            flashcard: tenantFlashcardFilter,
          },
        }),
        this.prisma.flashcard.count({ where: tenantFlashcardFilter }),
        this.prisma.flashcard.count({
          where: { ...tenantFlashcardFilter, reviews: { none: { userId } } },
        }),
      ]);

    // "Due now" should include new cards that haven't been touched yet —
    // a deck the user just generated is the most common case and the cards
    // legitimately *are* eligible for review right now.
    return {
      dueNow: dueNow + newCards,
      dueToday: dueToday + newCards,
      dueThisWeek: dueThisWeek + newCards,
      totalCards,
      reviewedToday,
    };
  }
}

// ── SM-2 math ───────────────────────────────────────────────────────────────

function updateEase(prev: number, quality: number): number {
  // Standard SM-2 adjustment. Bottoms out at MIN_EASE so chronically hard
  // cards still keep some spacing rather than collapsing to "show every day".
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  return Math.max(MIN_EASE, prev + delta);
}

function nextIntervalDays(
  prevInterval: number,
  prevReviewCount: number,
  ease: number,
  passed: boolean,
): number {
  if (!passed) return 1; // reset on failure
  if (prevReviewCount === 0) return 1; // first successful review
  if (prevReviewCount === 1) return 6; // canonical SM-2 second-step
  // Cap at 365 days so an exam-prep card that gets a couple of perfect
  // grades doesn't disappear for a year on a student who probably won't
  // come back to that course.
  return Math.min(365, Math.round(prevInterval * ease));
}
