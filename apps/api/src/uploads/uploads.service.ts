import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { ProblemException } from '../common/problem';
import { FoldersService } from '../folders/folders.service';
import { LocalModelsService } from '../local-models/local-models.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import type { UploadInitDto } from './dto/upload-init.dto';

const FREE_TIER_BYTE_LIMIT = 1 * 1024 * 1024 * 1024; // 1 GB

@Injectable()
export class UploadsService {
  private readonly log = new Logger(UploadsService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicEndpoint: string;
  private readonly aiWorkerUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly search: SearchService,
    private readonly folders: FoldersService,
    private readonly localModels: LocalModelsService,
  ) {
    const endpoint = process.env['S3_ENDPOINT'] ?? 'http://localhost:9000';
    this.bucket = process.env['S3_BUCKET'] ?? 'studyforge-uploads';
    this.publicEndpoint = process.env['S3_PUBLIC_ENDPOINT'] ?? endpoint;
    this.aiWorkerUrl = process.env['AI_WORKER_URL'] ?? 'http://localhost:8001';
    this.s3 = new S3Client({
      endpoint,
      region: process.env['S3_REGION'] ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env['S3_ACCESS_KEY'] ?? 'studyforge',
        secretAccessKey: process.env['S3_SECRET_KEY'] ?? 'studyforge-dev-secret',
      },
      forcePathStyle: true,
    });
  }

  /**
   * Two-shape init:
   *
   *   • Single-shot (default): returns ``{signedUrl}``. Caller PUTs the
   *     whole file in one request. Right for ≤ 5 MB.
   *   • Multipart (``dto.multipart === true``): returns ``{parts: [{
   *     partNumber, signedUrl }]}``. Caller PUTs each chunk to its
   *     pre-signed URL in parallel, collects the ETag header from each
   *     response, and passes them back to ``complete``. S3 reassembles.
   *
   * Multipart is the reliable-upload path: a dropped TCP connection
   * during one chunk only forces that chunk to be retried, not the
   * entire 200 MB file.
   */
  async init(
    tenantId: string,
    userId: string,
    email: string | undefined,
    dto: UploadInitDto,
  ): Promise<{
    uploadId: string;
    multipart: boolean;
    signedUrl?: string;
    parts?: Array<{ partNumber: number; signedUrl: string }>;
    publicUrl?: string;
    expiresAt: string;
    s3Key: string;
  }> {
    if (dto.sizeBytes > FREE_TIER_BYTE_LIMIT) {
      throw new ProblemException({
        status: 413,
        code: 'upload.size-exceeded',
        title: 'Upload exceeds the free-tier byte limit',
        detail: `Requested ${dto.sizeBytes} bytes; free-tier ceiling is ${FREE_TIER_BYTE_LIMIT}.`,
        fields: [{ name: 'sizeBytes', reason: `max-${FREE_TIER_BYTE_LIMIT}` }],
      });
    }

    await this.ensureTenant(tenantId);
    await this.ensureUser(tenantId, userId, email);

    const uploadId = randomUUID();
    const s3Key = `tenants/${tenantId}/uploads/${uploadId}/${dto.filename}`;
    const folderId = await this.folders.resolveOrInbox(tenantId, dto.folderId);

    if (dto.multipart) {
      // S3 requires every part except the last to be ≥ 5 MB. Use 5 MB as
      // the part target; the last part can be anything < 5 MB.
      const PART_BYTES = 5 * 1024 * 1024;
      const partCount = Math.min(10_000, Math.max(1, Math.ceil(dto.sizeBytes / PART_BYTES)));

      const created = await this.s3.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: s3Key,
          ContentType: dto.mime,
        }),
      );
      const s3UploadId = created.UploadId;
      if (!s3UploadId) {
        throw new ProblemException({
          status: 502,
          code: 'upload.multipart-init-failed',
          title: 'S3 did not return an UploadId',
        });
      }

      // Pre-sign every UploadPart URL up front. Each URL is independent
      // and valid for the same 15-minute window as the single-shot path.
      const parts: Array<{ partNumber: number; signedUrl: string }> = [];
      for (let i = 1; i <= partCount; i++) {
        const cmd = new UploadPartCommand({
          Bucket: this.bucket,
          Key: s3Key,
          PartNumber: i,
          UploadId: s3UploadId,
        });
        const url = await getSignedUrl(this.s3, cmd, { expiresIn: 15 * 60 });
        parts.push({ partNumber: i, signedUrl: this.toPublicUrl(url) });
      }

      await this.prisma.uploadBatch.create({
        data: {
          id: uploadId,
          tenantId,
          userId,
          courseId: dto.courseId ?? null,
          folderId,
          state: 'initiated',
          bundleSha256: dto.sha256,
          sizeBytes: BigInt(dto.sizeBytes),
          s3Key,
          mime: dto.mime,
          safetyFlags: [],
          s3MultipartUploadId: s3UploadId,
          partCount,
        },
      });

      this.log.log(
        `upload.init.multipart tenant=${tenantId} user=${userId} upload=${uploadId} size=${dto.sizeBytes} parts=${partCount}`,
      );

      return {
        uploadId,
        multipart: true,
        parts,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        s3Key,
      };
    }

    // Single-shot path (legacy, used for files < 5 MB).
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
      ContentType: dto.mime,
      ContentLength: dto.sizeBytes,
    });
    const signedUrl = await getSignedUrl(this.s3, command, { expiresIn: 15 * 60 });
    const publicUrl = this.toPublicUrl(signedUrl);

    await this.prisma.uploadBatch.create({
      data: {
        id: uploadId,
        tenantId,
        userId,
        courseId: dto.courseId ?? null,
        folderId,
        state: 'initiated',
        bundleSha256: dto.sha256,
        sizeBytes: BigInt(dto.sizeBytes),
        s3Key,
        mime: dto.mime,
        safetyFlags: [],
      },
    });

    this.log.log(
      `upload.init tenant=${tenantId} user=${userId} upload=${uploadId} size=${dto.sizeBytes}`,
    );

    return {
      uploadId,
      multipart: false,
      signedUrl: publicUrl,
      publicUrl,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      s3Key,
    };
  }

  async complete(
    tenantId: string,
    userId: string,
    uploadId: string,
    opts: { parts?: Array<{ partNumber: number; etag: string }> } = {},
  ): Promise<{
    uploadId: string;
    state: string;
    documentId?: string;
    chunkCount?: number;
  }> {
    const batch = await this.prisma.uploadBatch.findUnique({
      where: { id: uploadId },
    });
    if (batch === null || batch.userId !== userId) {
      throw new ProblemException({
        status: 404,
        code: 'upload.not-found',
        title: 'Upload not found',
      });
    }
    if (batch.tenantId !== tenantId) {
      throw new ProblemException({
        status: 403,
        code: 'upload.forbidden',
        title: 'Upload belongs to a different tenant',
      });
    }

    // Multipart upload: finalize via CompleteMultipartUpload before we
    // can HEAD the object — the object doesn't exist as a single key
    // until S3 stitches the parts together.
    if (batch.s3MultipartUploadId) {
      if (!opts.parts || opts.parts.length === 0) {
        throw new ProblemException({
          status: 400,
          code: 'upload.multipart-parts-missing',
          title: 'Multipart upload requires the parts array on complete',
          detail:
            'Each successful UploadPart response returned an ETag; pass them back as { parts: [{ partNumber, etag }, …] }.',
        });
      }
      const completed: CompletedPart[] = opts.parts
        .slice()
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag }));
      try {
        await this.s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.bucket,
            Key: batch.s3Key,
            UploadId: batch.s3MultipartUploadId,
            MultipartUpload: { Parts: completed },
          }),
        );
      } catch (err) {
        // Abandon the multipart upload to free server-side state — S3
        // charges for incomplete uploads if left around.
        await this.s3
          .send(
            new AbortMultipartUploadCommand({
              Bucket: this.bucket,
              Key: batch.s3Key,
              UploadId: batch.s3MultipartUploadId,
            }),
          )
          .catch(() => undefined);
        await this.prisma.uploadBatch.update({
          where: { id: uploadId },
          data: {
            state: 'failed',
            errorReason: err instanceof Error ? err.message.slice(0, 500) : 'multipart-complete-failed',
          },
        });
        throw new ProblemException({
          status: 502,
          code: 'upload.multipart-complete-failed',
          title: 'S3 rejected the multipart completion',
          detail: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    // Confirm the object actually landed in S3 (multipart or single-shot).
    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: batch.s3Key }),
      );
    } catch {
      throw new ProblemException({
        status: 409,
        code: 'upload.object-missing',
        title: 'Object was not uploaded to storage',
        detail: 'The signed URL was issued but no object exists at the key yet.',
      });
    }

    await this.prisma.uploadBatch.update({
      where: { id: uploadId },
      data: { state: 'uploaded', completedAt: new Date() },
    });

    // Trigger the ingest agent on the worker. We do this synchronously here
    // because a typical PDF parses in seconds and the user is waiting on the
    // result page. Heavy multi-doc archives move to BullMQ in Phase 2.
    const ingestResult = await this.triggerIngest({
      tenantId,
      uploadId,
      courseId: batch.courseId,
      folderId: batch.folderId,
      // Prefer the MIME the browser reported at init; fall back to the
      // filename extension only if it's missing or generic. Defaulting to
      // PDF was the bug that made every pptx parse as a 1-page PDF.
      mime: pickMime(batch.mime, batch.s3Key),
      s3Key: batch.s3Key,
      originalFilename: lastSegment(batch.s3Key),
    });

    await this.prisma.uploadBatch.update({
      where: { id: uploadId },
      data: { state: 'ready' },
    });

    // Flip any local offline model for this folder to "stale" so the user
    // sees a rebuild prompt. Cheap update, no-op when no model exists.
    if (batch.folderId) {
      void this.localModels
        .markFolderStale(tenantId, batch.folderId)
        .catch((err) => this.log.warn(`local-model stale mark failed: ${err}`));
    }

    // Push the freshly-ingested doc + its chunks into Meilisearch so the
    // global search palette can find it. Best-effort: a Meili outage
    // can't tank an upload.
    if (ingestResult.documentId) {
      void this.search
        .indexDocument(ingestResult.documentId)
        .catch((err) => this.log.warn(`search index failed: ${err}`));
    }

    // Notify the user that their material is parsed + indexed. ``in_app``
    // delivers immediately; email/push honour quiet hours + daily caps.
    void this.notifications
      .enqueue({
        tenantId,
        userId,
        kind: 'upload_ready',
        channels: ['in_app'],
        subject: `${lastSegment(batch.s3Key)} is ready to study`,
        body: `Indexed ${ingestResult.chunkCount ?? 0} chunk${ingestResult.chunkCount === 1 ? '' : 's'}. Open the Tutor or generate flashcards from your dashboard.`,
        meta: {
          uploadId,
          documentId: ingestResult.documentId,
          chunkCount: ingestResult.chunkCount,
        },
      })
      .catch((err) => this.log.warn(`upload-ready notification failed: ${err}`));

    return {
      uploadId,
      state: 'ready',
      documentId: ingestResult.documentId,
      chunkCount: ingestResult.chunkCount,
    };
  }

  /**
   * URL-based ingest (YouTube today; podcast / website later). Skips the
   * S3 round-trip entirely — the worker fetches the captions and writes
   * a Document with a synthetic ``s3Key`` like ``youtube://abc123``. We
   * still create an ``UploadBatch`` so the rest of the system (stale
   * markers on local models, notifications, indexing) treats this the
   * same way as a file upload.
   */
  async ingestYoutube(
    tenantId: string,
    userId: string,
    email: string,
    dto: { url: string; folderId?: string | null },
  ): Promise<{ uploadId: string; state: string; documentId: string; chunkCount: number; title: string }> {
    await this.ensureTenant(tenantId);
    await this.ensureUser(tenantId, userId, email);

    const uploadId = randomUUID();
    const folderId = await this.folders.resolveOrInbox(tenantId, dto.folderId ?? undefined);

    // Synthetic batch: state goes straight to "uploaded" because we never
    // hit S3. The worker call below flips it to "ready" on success or
    // "failed" if the captions endpoint refuses.
    await this.prisma.uploadBatch.create({
      data: {
        id: uploadId,
        tenantId,
        userId,
        courseId: null,
        folderId,
        state: 'uploaded',
        bundleSha256: `youtube:${dto.url}`,
        sizeBytes: BigInt(0),
        s3Key: `youtube://pending/${uploadId}`,
        mime: 'text/plain',
        safetyFlags: [],
      },
    });

    let workerJson: {
      document_id: string;
      document_version_id: string;
      chunk_count: number;
      embedded_chunks: number;
      title: string;
      transcript_chars: number;
    };
    try {
      const res = await fetch(`${this.aiWorkerUrl}/v1/ingest/url`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          user_id: userId,
          course_id: null,
          folder_id: folderId,
          upload_batch_id: uploadId,
          url: dto.url,
          source: 'youtube',
        }),
      });
      if (!res.ok) {
        let detail: string;
        try {
          const body = (await res.json()) as { detail?: string };
          detail = body.detail ?? `worker returned ${res.status}`;
        } catch {
          detail = (await res.text()).slice(0, 400);
        }
        await this.prisma.uploadBatch.update({
          where: { id: uploadId },
          data: { state: 'failed', errorReason: detail.slice(0, 500) },
        });
        throw new ProblemException({
          status: res.status === 400 || res.status === 404 ? res.status : 502,
          code: 'ingest.youtube-failed',
          title: 'YouTube ingest failed',
          detail,
        });
      }
      workerJson = (await res.json()) as typeof workerJson;
    } catch (err) {
      if (err instanceof ProblemException) throw err;
      const detail = err instanceof Error ? err.message : 'unknown';
      await this.prisma.uploadBatch.update({
        where: { id: uploadId },
        data: { state: 'failed', errorReason: detail.slice(0, 500) },
      }).catch(() => undefined);
      throw new ProblemException({
        status: 502,
        code: 'ingest.youtube-network',
        title: 'Could not reach the worker',
        detail,
      });
    }

    await this.prisma.uploadBatch.update({
      where: { id: uploadId },
      data: { state: 'ready', completedAt: new Date() },
    });

    if (folderId) {
      void this.localModels
        .markFolderStale(tenantId, folderId)
        .catch((err) => this.log.warn(`local-model stale mark failed: ${err}`));
    }
    void this.search
      .indexDocument(workerJson.document_id)
      .catch((err) => this.log.warn(`search index failed: ${err}`));
    void this.notifications
      .enqueue({
        tenantId,
        userId,
        kind: 'upload_ready',
        channels: ['in_app'],
        subject: `${workerJson.title} is ready to study`,
        body: `Indexed ${workerJson.chunk_count} chunk${workerJson.chunk_count === 1 ? '' : 's'} from a YouTube transcript.`,
        meta: {
          uploadId,
          documentId: workerJson.document_id,
          chunkCount: workerJson.chunk_count,
          source: 'youtube',
        },
      })
      .catch((err) => this.log.warn(`youtube-ready notification failed: ${err}`));

    return {
      uploadId,
      state: 'ready',
      documentId: workerJson.document_id,
      chunkCount: workerJson.chunk_count,
      title: workerJson.title,
    };
  }

  /**
   * Plain-text ingest. The browser extension uses this to capture page
   * content (readable text from a webpage, a copied selection, etc.)
   * without uploading anything to S3. Architecturally identical to the
   * YouTube path: synthetic UploadBatch, plaintext bytes go through the
   * normal ingest pipeline, downstream stale-marking and notifications
   * fire as usual.
   */
  async ingestText(
    tenantId: string,
    userId: string,
    email: string,
    dto: { folderId?: string | null; title: string; text: string; sourceUrl?: string | null },
  ): Promise<{ uploadId: string; state: string; documentId: string; chunkCount: number; title: string }> {
    await this.ensureTenant(tenantId);
    await this.ensureUser(tenantId, userId, email);

    const uploadId = randomUUID();
    const folderId = await this.folders.resolveOrInbox(tenantId, dto.folderId ?? undefined);

    await this.prisma.uploadBatch.create({
      data: {
        id: uploadId,
        tenantId,
        userId,
        courseId: null,
        folderId,
        state: 'uploaded',
        bundleSha256: `text:${uploadId}`,
        sizeBytes: BigInt(dto.text.length),
        s3Key: dto.sourceUrl ?? `text://pending/${uploadId}`,
        mime: 'text/plain',
        safetyFlags: [],
      },
    });

    let workerJson: {
      document_id: string;
      document_version_id: string;
      chunk_count: number;
      embedded_chunks: number;
      title: string;
      text_chars: number;
    };
    try {
      const res = await fetch(`${this.aiWorkerUrl}/v1/ingest/text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          user_id: userId,
          course_id: null,
          folder_id: folderId,
          upload_batch_id: uploadId,
          title: dto.title.slice(0, 400),
          text: dto.text,
          source_url: dto.sourceUrl ?? null,
        }),
      });
      if (!res.ok) {
        let detail: string;
        try {
          const body = (await res.json()) as { detail?: string };
          detail = body.detail ?? `worker returned ${res.status}`;
        } catch {
          detail = (await res.text()).slice(0, 400);
        }
        await this.prisma.uploadBatch.update({
          where: { id: uploadId },
          data: { state: 'failed', errorReason: detail.slice(0, 500) },
        });
        throw new ProblemException({
          status: res.status === 400 ? 400 : 502,
          code: 'ingest.text-failed',
          title: 'Text ingest failed',
          detail,
        });
      }
      workerJson = (await res.json()) as typeof workerJson;
    } catch (err) {
      if (err instanceof ProblemException) throw err;
      const detail = err instanceof Error ? err.message : 'unknown';
      await this.prisma.uploadBatch
        .update({ where: { id: uploadId }, data: { state: 'failed', errorReason: detail.slice(0, 500) } })
        .catch(() => undefined);
      throw new ProblemException({
        status: 502,
        code: 'ingest.text-network',
        title: 'Could not reach the worker',
        detail,
      });
    }

    await this.prisma.uploadBatch.update({
      where: { id: uploadId },
      data: { state: 'ready', completedAt: new Date() },
    });

    if (folderId) {
      void this.localModels
        .markFolderStale(tenantId, folderId)
        .catch((err) => this.log.warn(`local-model stale mark failed: ${err}`));
    }
    void this.search
      .indexDocument(workerJson.document_id)
      .catch((err) => this.log.warn(`search index failed: ${err}`));
    void this.notifications
      .enqueue({
        tenantId,
        userId,
        kind: 'upload_ready',
        channels: ['in_app'],
        subject: `${workerJson.title} is ready to study`,
        body: `Indexed ${workerJson.chunk_count} chunk${workerJson.chunk_count === 1 ? '' : 's'} from a captured webpage.`,
        meta: {
          uploadId,
          documentId: workerJson.document_id,
          chunkCount: workerJson.chunk_count,
          source: 'text',
          sourceUrl: dto.sourceUrl ?? null,
        },
      })
      .catch((err) => this.log.warn(`text-ready notification failed: ${err}`));

    return {
      uploadId,
      state: 'ready',
      documentId: workerJson.document_id,
      chunkCount: workerJson.chunk_count,
      title: workerJson.title,
    };
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private toPublicUrl(signed: string): string {
    try {
      const internal = new URL(process.env['S3_ENDPOINT'] ?? 'http://minio:9000');
      const externalHost = new URL(this.publicEndpoint).host;
      const url = new URL(signed);
      if (url.host === internal.host || url.host === 'minio:9000') {
        url.host = externalHost;
      }
      return url.toString();
    } catch {
      return signed;
    }
  }

  private async ensureTenant(tenantId: string): Promise<void> {
    const exists = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (exists !== null) return;
    await this.prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Personal',
        slug: `personal-${tenantId.slice(0, 8)}`,
      },
    });
  }

  private async ensureUser(
    tenantId: string,
    userId: string,
    email: string | undefined,
  ): Promise<void> {
    const exists = await this.prisma.user.findUnique({ where: { id: userId } });
    if (exists !== null) return;
    await this.prisma.user.create({
      data: {
        id: userId,
        tenantId,
        email: email ?? `dev-${userId.slice(0, 8)}@studyforge.local`,
      },
    });
  }

  private async triggerIngest(req: {
    tenantId: string;
    uploadId: string;
    courseId: string | null;
    folderId: string | null;
    mime: string;
    s3Key: string;
    originalFilename: string;
  }): Promise<{ documentId?: string; chunkCount?: number }> {
    const url = `${this.aiWorkerUrl}/v1/agents/runs`;
    const body = {
      kind: 'ingest.process.v1',
      tenant_id: req.tenantId,
      input: {
        tenant_id: req.tenantId,
        course_id: req.courseId,
        folder_id: req.folderId,
        upload_batch_id: req.uploadId,
        mime: req.mime,
        original_filename: req.originalFilename,
        s3_key: req.s3Key,
      },
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      this.log.error(`ingest agent failed: ${response.status} ${text}`);
      throw new ProblemException({
        status: 502,
        code: 'upload.ingest-failed',
        title: 'Ingest pipeline failed',
        detail: text.slice(0, 200),
      });
    }
    const json = (await response.json()) as {
      state: string;
      result?: { document_id?: string; chunk_count?: number; embedded_chunk_count?: number };
      error?: string;
    };
    if (json.state !== 'succeeded') {
      // The worker prefixes errors with ``agent <name>: `` for log triage.
      // Strip it before the FE so the upload toast shows the human-readable
      // message (e.g. "Audio transcription is disabled on the public demo")
      // rather than the operator-facing breadcrumb.
      const rawError = json.error ?? json.state;
      const friendly = rawError.replace(/^agent [\w.-]+: /, '');
      throw new ProblemException({
        status: 502,
        code: 'upload.ingest-failed',
        title: 'Ingest pipeline did not succeed',
        detail: friendly,
      });
    }
    return {
      documentId: json.result?.document_id,
      chunkCount: json.result?.chunk_count,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function lastSegment(key: string): string {
  const idx = key.lastIndexOf('/');
  return idx === -1 ? key : key.slice(idx + 1);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ipynb': 'application/x-ipynb+json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
};

function guessMimeFromKey(key: string): string {
  const lower = key.toLowerCase();
  for (const [ext, mime] of Object.entries(MIME_BY_EXTENSION)) {
    if (lower.endsWith(ext)) return mime;
  }
  return 'application/octet-stream';
}

function pickMime(stored: string | null | undefined, s3Key: string): string {
  if (stored && stored !== 'application/octet-stream') return stored;
  return guessMimeFromKey(s3Key);
}
