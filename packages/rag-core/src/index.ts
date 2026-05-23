/**
 * RAG core — TypeScript-side type mirror of `apps/ai-worker/src/rag/contracts.py`.
 *
 * The orchestrator (NestJS gateway) calls into the Python ai-worker over HTTP;
 * these types are the wire format. They are the authoritative shape for the FE
 * as well, re-exported through `@studyforge/shared-types` once that wiring lands
 * in Phase 1.
 *
 * Implementation note: the orchestrator and the actual retrieval logic live in
 * Python. This package only ships shapes + small pure helpers (currently RRF
 * for parity testing — same algorithm, same tie-break, same constants).
 */

export type RetrieverKind = 'dense' | 'sparse' | 'kg';

export interface Candidate {
  chunkId: string;
  rank: number;
  score: number;
  kind: RetrieverKind;
}

export interface RetrievedChunk {
  chunkId: string;
  docId: string;
  versionId: string;
  page: number | null;
  slide: number | null;
  cell: number | null;
  charStart: number;
  charEnd: number;
  /** Reranker output, clamped to [0, 1]. */
  score: number;
  content: string;
  modality: string;
  headingPath: string[];
}

export interface MetadataFilter {
  documentIds?: string[];
  modalities?: string[];
  /** ISO-8601 timestamp; chunks older than this are skipped. */
  minFreshnessIso?: string;
}

export interface RetrievalRequest {
  tenantId: string;
  courseId: string | null;
  query: string;
  /** Final number of chunks returned. */
  k: number;
  /** RRF k. */
  fusionK: number;
  /** Candidates per underlying retriever before fusion. */
  candidatesPerRetriever: number;
  metadataFilter?: MetadataFilter;
}

export interface RetrievalTelemetry {
  denseCandidates: number;
  sparseCandidates: number;
  fusedCandidates: number;
  rerankedReturned: number;
  semanticCacheHit: boolean;
  exactCacheHit: boolean;
  kgExpanded: boolean;
  denseLatencyMs: number;
  sparseLatencyMs: number;
  rerankLatencyMs: number;
  totalLatencyMs: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  telemetry: RetrievalTelemetry;
  diagnostics: Record<string, unknown>;
}

/**
 * Reciprocal Rank Fusion. Mirror of the Python implementation:
 *   RRF_score(c) = Σ_r 1 / (k + rank_r(c))
 *
 * Same tie-break (alphabetical by chunkId) so eval golden sets stay stable
 * regardless of which side generates them.
 */
export function reciprocalRankFusion(
  rankings: Candidate[][],
  k = 60,
): Candidate[] {
  if (k < 1) throw new Error('k must be >= 1');

  const scores = new Map<string, number>();
  const firstSource = new Map<string, Candidate>();

  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank++) {
      const candidate = ranking[rank];
      if (!candidate) continue;
      const prev = scores.get(candidate.chunkId) ?? 0;
      scores.set(candidate.chunkId, prev + 1 / (k + rank + 1));
      if (!firstSource.has(candidate.chunkId)) {
        firstSource.set(candidate.chunkId, candidate);
      }
    }
  }

  const sortedIds = [...scores.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  return sortedIds.map(([chunkId, score], newRank) => {
    const original = firstSource.get(chunkId);
    if (!original) throw new Error(`unreachable: ${chunkId} missing from firstSource`);
    return {
      chunkId,
      rank: newRank,
      score: Number(score.toFixed(12)),
      kind: original.kind,
    };
  });
}

export const RAG_CORE_VERSION = '0.1.0';
