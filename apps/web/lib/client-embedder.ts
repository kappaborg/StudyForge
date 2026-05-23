'use client';

/**
 * Lazy singleton wrapper around a small sentence-embedding model from
 * @huggingface/transformers. We use `Xenova/all-MiniLM-L6-v2` (384 dims,
 * ~25 MB quantised) because:
 *
 *   • Small enough that the first-run download UX is a few seconds, not
 *     minutes — important when the user is staring at a "Build offline
 *     tutor" progress bar.
 *   • Quality is good enough for chunk-level retrieval on lecture notes;
 *     it's a workhorse for client-side RAG and matches what the server
 *     uses as a fallback when fastembed is stubbed.
 *   • The library caches the ONNX weights in IndexedDB after the first
 *     download, so subsequent builds skip the network.
 *
 * The embedder lives outside any React component so two simultaneous
 * builders (in unlikely tabs) share the same instance.
 */

import type { FeatureExtractionPipeline } from '@huggingface/transformers';

export const EMBEDDER_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDER_DIM = 384;

let _pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(
  onProgress?: (event: { status: string; progress?: number; file?: string }) => void,
): Promise<FeatureExtractionPipeline> {
  if (_pipelinePromise) return _pipelinePromise;
  _pipelinePromise = (async () => {
    const transformers = await import('@huggingface/transformers');
    // Disable local model lookup — we want the CDN-hosted weights to land
    // in IndexedDB on first run.
    transformers.env.allowLocalModels = false;
    transformers.env.allowRemoteModels = true;
    const pipe = await transformers.pipeline('feature-extraction', EMBEDDER_ID, {
      dtype: 'fp32',
      progress_callback: (e: { status: string; progress?: number; file?: string }) =>
        onProgress?.(e),
    });
    return pipe as FeatureExtractionPipeline;
  })();
  try {
    return await _pipelinePromise;
  } catch (err) {
    // Reset so the next call retries the download rather than caching the
    // rejected promise forever.
    _pipelinePromise = null;
    throw err;
  }
}

export async function warmEmbedder(
  onProgress?: (e: { status: string; progress?: number; file?: string }) => void,
): Promise<void> {
  await getPipeline(onProgress);
}

/**
 * Embeds a single piece of text → Float32Array of length EMBEDDER_DIM.
 * Mean-pools the token embeddings and L2-normalises so dot-product == cosine.
 */
export async function embed(text: string): Promise<Float32Array> {
  const pipe = await getPipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  // transformers.js returns a Tensor; .data is a Float32Array view.
  return new Float32Array((output as unknown as { data: Float32Array }).data);
}

/**
 * Batched embed for many chunks. Internally calls the pipeline once per
 * batch so the JS↔WASM boundary doesn't get hammered.
 */
export async function embedBatch(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  const BATCH = 16;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const tensor = await pipe(slice, { pooling: 'mean', normalize: true });
    const view = tensor as unknown as { data: Float32Array; dims: number[] };
    const data = view.data;
    const dims = view.dims;
    const stride = dims.length > 0 ? (dims[dims.length - 1] ?? EMBEDDER_DIM) : EMBEDDER_DIM;
    for (let j = 0; j < slice.length; j++) {
      out.push(data.slice(j * stride, (j + 1) * stride));
    }
    onProgress?.(Math.min(i + slice.length, texts.length), texts.length);
  }
  return out;
}

/** Plain cosine similarity for two equally-sized vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  // Vectors are L2-normalised at embed time, so dot product == cosine.
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}
