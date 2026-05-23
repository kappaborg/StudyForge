import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
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

  async init(
    tenantId: string,
    userId: string,
    email: string | undefined,
    dto: UploadInitDto,
  ): Promise<{
    uploadId: string;
    signedUrl: string;
    publicUrl: string;
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

    // Ensure tenant + user exist (dev-mode auto-provision; OAuth signup
    // replaces this in Phase 1 mid).
    await this.ensureTenant(tenantId);
    await this.ensureUser(tenantId, userId, email);

    const uploadId = randomUUID();
    const s3Key = `tenants/${tenantId}/uploads/${uploadId}/${dto.filename}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
      ContentType: dto.mime,
      ContentLength: dto.sizeBytes,
    });
    const signedUrl = await getSignedUrl(this.s3, command, { expiresIn: 15 * 60 });

    // Rewrite the host so the browser uploads against the externally-reachable
    // MinIO console URL (the API sees the internal hostname when running in
    // docker compose, the browser sees ``localhost``).
    const publicUrl = this.toPublicUrl(signedUrl);

    // Resolve folderId now so the ``complete`` handler can write
    // Document.folderId without another roundtrip. Unspecified → Inbox.
    const folderId = await this.folders.resolveOrInbox(tenantId, dto.folderId);

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

    // Confirm the object actually landed in S3.
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
      throw new ProblemException({
        status: 502,
        code: 'upload.ingest-failed',
        title: 'Ingest pipeline did not succeed',
        detail: json.error ?? json.state,
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
