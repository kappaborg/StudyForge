import { z } from 'zod';

export const Citation = z.object({
  docId: z.string().uuid(),
  versionId: z.string().uuid(),
  chunkId: z.string().uuid(),
  page: z.number().int().nullable(),
  slide: z.number().int().nullable(),
  cell: z.number().int().nullable(),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().nonnegative(),
  score: z.number().min(0).max(1),
});
export type Citation = z.infer<typeof Citation>;

export const CitedResponse = z.object({
  text: z.string(),
  citations: z.array(Citation).min(1, 'every response must carry at least one citation'),
  model: z.string(),
  providerId: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  cacheHit: z.boolean(),
});
export type CitedResponse = z.infer<typeof CitedResponse>;
