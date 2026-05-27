import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CoursesService } from '../common/courses.service';
import { FoldersService } from '../folders/folders.service';

/**
 * Seeds a synthetic "Intro to Photosynthesis" study pack into a freshly
 * created tenant so first-time users land on a non-empty dashboard.
 *
 * Idempotent: skips if the tenant already owns any non-trashed document.
 * Best-effort: any failure logs a warning but never blocks the calling
 * sign-in flow.
 *
 * What gets created:
 *   • One Document + DocumentVersion + 4 chunks under the Inbox folder
 *   • One FlashcardDeck with 3 cards under the Inbox course
 *   • One Quiz with 5 multiple-choice items under the Inbox course
 *
 * No embeddings are written — the demo's primary value is the cards and
 * quiz, both of which work without RAG. If the user wants the demo doc
 * to show up in tutor citations, the existing deep-index path will tag
 * it on next upload.
 */
@Injectable()
export class DemoSeederService {
  private readonly log = new Logger(DemoSeederService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly folders: FoldersService,
  ) {}

  async seedForTenant(tenantId: string, userId: string): Promise<void> {
    try {
      // Idempotency: only seed brand-new tenants. If the tenant already
      // has documents, the user has been around and we'd be polluting
      // their workspace.
      const existing = await this.prisma.document.count({
        where: { tenantId, deletedAt: null },
      });
      if (existing > 0) return;

      const courseId = await this.courses.ensureInbox(tenantId);
      const folderId = await this.folders.inboxFolderId(tenantId);

      await this.seedDocument(tenantId, userId, courseId, folderId);
      await this.seedFlashcards(courseId);
      await this.seedQuiz(courseId);
      this.log.log(
        `demo.seeded tenant=${tenantId.slice(0, 8)} (doc + deck + quiz)`,
      );
    } catch (err) {
      // Never crash the sign-in flow on seed failure.
      this.log.warn(`demo.seed_failed tenant=${tenantId.slice(0, 8)} err=${err}`);
    }
  }

  // ── document ────────────────────────────────────────────────────────────

  private async seedDocument(
    tenantId: string,
    userId: string,
    courseId: string,
    folderId: string,
  ): Promise<void> {
    const bodyText = DEMO_BODY;
    const contentHash = sha256(bodyText);
    const batch = await this.prisma.uploadBatch.create({
      data: {
        tenantId,
        userId,
        courseId,
        folderId,
        state: 'ready',
        bundleSha256: contentHash,
        sizeBytes: BigInt(Buffer.byteLength(bodyText, 'utf8')),
        s3Key: `demo://seed/${contentHash.slice(0, 16)}`,
        mime: 'text/plain',
        safetyFlags: [],
        completedAt: new Date(),
      },
    });
    const doc = await this.prisma.document.create({
      data: {
        tenantId,
        courseId,
        folderId,
        uploadBatchId: batch.id,
        originalFilename: 'Welcome — Intro to Photosynthesis.txt',
        mime: 'text/plain',
        s3Key: `demo://seed/${contentHash.slice(0, 16)}`,
        pageCount: 1,
      },
    });
    const version = await this.prisma.documentVersion.create({
      data: {
        documentId: doc.id,
        versionNumber: 1,
        contentSha256: contentHash,
        bytesSha256: contentHash,
      },
    });
    // Split the body into ~paragraph-sized chunks. Hand-marked so the
    // boundaries fall on topical sentences, not arbitrary char offsets —
    // the chunker would do the same thing on a real ingest.
    let cursor = 0;
    const chunkRows = DEMO_CHUNKS.map((content, i) => {
      const charStart = cursor;
      cursor += content.length;
      return {
        documentVersionId: version.id,
        ordinal: i,
        modality: 'text' as const,
        page: 1,
        charStart,
        charEnd: cursor,
        content,
      };
    });
    await this.prisma.chunk.createMany({ data: chunkRows });
  }

  // ── flashcards ──────────────────────────────────────────────────────────

  private async seedFlashcards(courseId: string): Promise<void> {
    const deck = await this.prisma.flashcardDeck.create({
      data: {
        courseId,
        title: 'Photosynthesis basics',
      },
    });
    await this.prisma.flashcard.createMany({
      data: DEMO_FLASHCARDS.map(({ front, back }) => ({
        deckId: deck.id,
        front,
        back,
      })),
    });
  }

  // ── quiz ────────────────────────────────────────────────────────────────

  private async seedQuiz(courseId: string): Promise<void> {
    const quiz = await this.prisma.quiz.create({
      data: {
        courseId,
        title: 'Photosynthesis check-in',
        difficulty: 30,
      },
    });
    for (const item of DEMO_QUIZ_ITEMS) {
      await this.prisma.quizItem.create({
        data: {
          quizId: quiz.id,
          kind: 'mcq',
          prompt: item.prompt,
          payload: {
            options: item.options,
            correctIndex: item.correctIndex,
          },
          rationale: item.rationale,
          difficulty: 30,
        },
      });
    }
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ── demo content ─────────────────────────────────────────────────────────

const DEMO_CHUNKS = [
  'Welcome to StudyForge. This short note is here so the dashboard has something for you to poke at on day one — drop a real PDF whenever you want and these placeholders fade into the background.\n\n',
  'Photosynthesis is the process plants, algae, and some bacteria use to turn light energy into chemical energy. The light is captured by chlorophyll, the green pigment in chloroplasts. Water (H2O) is split, carbon dioxide (CO2) is fixed, and the cell ends up with glucose (C6H12O6) plus oxygen (O2) as a by-product.\n\n',
  'Two stages run back-to-back. The light-dependent reactions happen in the thylakoid membrane and need photons; they output ATP and NADPH. The Calvin cycle (light-independent) happens in the stroma and uses that ATP+NADPH to fix CO2 into sugars. Each cycle needs three CO2 molecules to produce one G3P, and two G3P molecules combine to form glucose.\n\n',
  'Why it matters: photosynthesis is the entry point of almost all energy into the food web. The oxygen in the air you are breathing right now came from this reaction. Net equation: 6 CO2 + 6 H2O + light → C6H12O6 + 6 O2.',
];

const DEMO_BODY = DEMO_CHUNKS.join('');

const DEMO_FLASHCARDS = [
  {
    front: 'What is the net equation of photosynthesis?',
    back: '6 CO2 + 6 H2O + light energy → C6H12O6 + 6 O2',
  },
  {
    front: 'Where do the light-dependent reactions take place?',
    back: 'In the thylakoid membrane of the chloroplast. They produce ATP and NADPH and release O2 from water.',
  },
  {
    front: 'What does the Calvin cycle do, in one sentence?',
    back: 'It uses ATP and NADPH (from the light-dependent stage) to fix CO2 into glucose, in the stroma of the chloroplast.',
  },
];

const DEMO_QUIZ_ITEMS = [
  {
    prompt: 'Which pigment is primarily responsible for capturing light energy in plants?',
    options: ['Carotene', 'Chlorophyll', 'Anthocyanin', 'Xanthophyll'],
    correctIndex: 1,
    rationale:
      'Chlorophyll absorbs light most strongly in the blue and red wavelengths, reflecting green — which is why most leaves look green.',
  },
  {
    prompt: 'Where in the chloroplast does the Calvin cycle occur?',
    options: ['Thylakoid membrane', 'Outer membrane', 'Stroma', 'Granum lumen'],
    correctIndex: 2,
    rationale:
      'The Calvin cycle runs in the stroma, the fluid-filled space surrounding the thylakoids.',
  },
  {
    prompt:
      'How many CO2 molecules are required to produce one molecule of glucose in the Calvin cycle?',
    options: ['1', '3', '6', '12'],
    correctIndex: 2,
    rationale:
      'Each CO2 contributes one carbon; glucose has six carbons, so six CO2 molecules are fixed per glucose.',
  },
  {
    prompt: 'Which two products are output by the light-dependent reactions?',
    options: ['Glucose + O2', 'ATP + NADPH', 'CO2 + H2O', 'NADH + FADH2'],
    correctIndex: 1,
    rationale:
      'ATP and NADPH are the energy + reducing-power carriers passed on to the Calvin cycle. O2 is a by-product, not a primary "product" used downstream.',
  },
  {
    prompt: 'What is the source of the oxygen released during photosynthesis?',
    options: ['CO2', 'H2O', 'Glucose', 'ATP'],
    correctIndex: 1,
    rationale:
      'Water is split during the light reactions, releasing O2. The oxygen in CO2 ends up in the carbohydrate, not in the released gas.',
  },
];
