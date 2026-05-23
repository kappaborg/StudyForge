import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  addDocuments,
  deleteByFilter,
  ensureIndex,
  searchIndex,
  setFilterable,
} from './meili-client';

const DOCUMENTS_INDEX = 'documents';
const CHUNKS_INDEX = 'chunks';
const CONCEPTS_INDEX = 'concepts';

interface DocumentHitRaw {
  id: string;
  tenantId: string;
  courseId: string | null;
  originalFilename: string;
  mime: string;
  pageCount: number | null;
  createdAt: number;
}

interface ChunkHitRaw {
  id: string;
  tenantId: string;
  courseId: string | null;
  documentId: string;
  documentVersionId: string;
  content: string;
  page: number | null;
  slide: number | null;
}

interface ConceptHitRaw {
  id: string;
  tenantId: string;
  courseId: string;
  label: string;
  description: string | null;
  difficulty: number;
}

export interface SearchHit {
  kind: 'document' | 'chunk' | 'concept';
  id: string;
  title: string;
  snippet: string;
  docId?: string;
  courseId?: string | null;
  page?: number | null;
}

/**
 * Meilisearch wrapper.
 *
 * Three indexes — ``documents``, ``chunks``, ``concepts`` — each scoped
 * by ``tenantId`` (filterable). Re-indexing is best-effort: write failures
 * are logged but never crash the request path that triggered them. The
 * ``SearchController`` reads from these indexes via ``search()``.
 */
@Injectable()
export class SearchService implements OnModuleInit {
  private readonly log = new Logger(SearchService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    // Ensure indexes exist + filterable attrs configured. Cheap on cold
    // boot; idempotent on restarts.
    try {
      const setup: Array<[string, string[]]> = [
        [DOCUMENTS_INDEX, ['tenantId', 'courseId', 'mime']],
        [CHUNKS_INDEX, ['tenantId', 'courseId', 'documentId']],
        [CONCEPTS_INDEX, ['tenantId', 'courseId']],
      ];
      for (const [uid, filterable] of setup) {
        await ensureIndex(uid);
        await setFilterable(uid, filterable);
      }
    } catch (err) {
      this.log.warn(`meilisearch init failed (search will degrade): ${err}`);
    }
  }

  /** Upsert a single document into the documents + chunks indexes. Called
   *  by the uploads service once ingest completes. */
  async indexDocument(documentId: string): Promise<void> {
    try {
      const doc = await this.prisma.document.findUnique({
        where: { id: documentId },
        include: { versions: { include: { chunks: true }, orderBy: { versionNumber: 'desc' }, take: 1 } },
      });
      if (!doc) return;
      const docHit: DocumentHitRaw = {
        id: doc.id,
        tenantId: doc.tenantId,
        courseId: doc.courseId,
        originalFilename: doc.originalFilename,
        mime: doc.mime,
        pageCount: doc.pageCount,
        createdAt: doc.createdAt.getTime(),
      };
      await addDocuments(DOCUMENTS_INDEX, [docHit]);

      const latest = doc.versions[0];
      if (!latest) return;
      const chunkHits: ChunkHitRaw[] = latest.chunks.map((c) => ({
        id: c.id,
        tenantId: doc.tenantId,
        courseId: doc.courseId,
        documentId: doc.id,
        documentVersionId: latest.id,
        content: c.content.slice(0, 1500),
        page: c.page,
        slide: c.slide,
      }));
      if (chunkHits.length > 0) {
        await addDocuments(CHUNKS_INDEX, chunkHits);
      }
    } catch (err) {
      this.log.warn(`indexDocument(${documentId}) failed: ${err}`);
    }
  }

  /** Replace the concept index for a course (the extract handler wipes +
   *  rewrites concepts in one go; mirror that here). */
  async indexConceptsForCourse(courseId: string, tenantId: string): Promise<void> {
    try {
      const concepts = await this.prisma.concept.findMany({ where: { courseId } });
      // Remove stale entries for this course.
      await deleteByFilter(CONCEPTS_INDEX, `courseId = "${courseId}"`);
      if (concepts.length === 0) return;
      const hits: ConceptHitRaw[] = concepts.map((c) => ({
        id: c.id,
        tenantId,
        courseId,
        label: c.label,
        description: c.description ?? '',
        difficulty: c.difficulty,
      }));
      await addDocuments(CONCEPTS_INDEX, hits);
    } catch (err) {
      this.log.warn(`indexConceptsForCourse(${courseId}) failed: ${err}`);
    }
  }

  /** Cross-index search scoped to a tenant. */
  async search(opts: {
    query: string;
    tenantId: string;
    limit?: number;
  }): Promise<SearchHit[]> {
    const limit = opts.limit ?? 10;
    const tenantFilter = `tenantId = "${opts.tenantId}"`;
    try {
      const [docs, chunks, concepts] = await Promise.all([
        searchIndex<DocumentHitRaw>(DOCUMENTS_INDEX, opts.query, { filter: tenantFilter, limit }),
        searchIndex<ChunkHitRaw>(CHUNKS_INDEX, opts.query, { filter: tenantFilter, limit }),
        searchIndex<ConceptHitRaw>(CONCEPTS_INDEX, opts.query, { filter: tenantFilter, limit }),
      ]);

      const hits: SearchHit[] = [];
      for (const d of docs.hits) {
        hits.push({
          kind: 'document',
          id: d.id,
          title: d.originalFilename,
          snippet: `${d.mime}${d.pageCount ? ` · ${d.pageCount} page${d.pageCount === 1 ? '' : 's'}` : ''}`,
          courseId: d.courseId,
        });
      }
      for (const c of chunks.hits) {
        hits.push({
          kind: 'chunk',
          id: c.id,
          title: snippetTitle(c.content),
          snippet: c.content.slice(0, 220),
          docId: c.documentId,
          courseId: c.courseId,
          page: c.page,
        });
      }
      for (const k of concepts.hits) {
        hits.push({
          kind: 'concept',
          id: k.id,
          title: k.label,
          snippet: k.description ?? '',
          courseId: k.courseId,
        });
      }
      return hits;
    } catch (err) {
      this.log.warn(`search failed: ${err}`);
      return [];
    }
  }
}

function snippetTitle(content: string): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 80) return cleaned;
  return cleaned.slice(0, 80) + '…';
}
