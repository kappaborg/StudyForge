import { z } from 'zod';

export const SupportedMime = z.enum([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'text/x-python',
  'application/x-ipynb+json',
  'application/zip',
  'application/x-rar-compressed',
  'application/gzip',
  'application/json',
  'text/plain',
  'text/markdown',
]);
export type SupportedMime = z.infer<typeof SupportedMime>;

export const UploadInitRequest = z.object({
  courseId: z.string().uuid().nullable(),
  filename: z.string().min(1).max(255),
  mime: SupportedMime,
  sizeBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type UploadInitRequest = z.infer<typeof UploadInitRequest>;

export const UploadInitResponse = z.object({
  uploadId: z.string().uuid(),
  signedUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type UploadInitResponse = z.infer<typeof UploadInitResponse>;
