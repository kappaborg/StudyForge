import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Supported MIME types. Mirrors `SupportedMime` in @studyforge/shared-types so
 * FE and BE stay in lockstep. Reject anything else at the boundary.
 */
const SUPPORTED_MIME = [
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
] as const;

export class UploadInitDto {
  @ApiProperty({ format: 'uuid', nullable: true, required: false })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiProperty({ format: 'uuid', nullable: true, required: false })
  @IsOptional()
  @IsUUID()
  folderId?: string;

  @ApiProperty({ minLength: 1, maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;

  @ApiProperty({ enum: SUPPORTED_MIME })
  @IsIn(SUPPORTED_MIME as unknown as string[])
  mime!: (typeof SUPPORTED_MIME)[number];

  @ApiProperty({ minimum: 1, maximum: 2 * 1024 * 1024 * 1024 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2 * 1024 * 1024 * 1024)
  sizeBytes!: number;

  @ApiProperty({ pattern: '^[a-f0-9]{64}$' })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  sha256!: string;

  @ApiProperty({
    required: false,
    description:
      'Request an S3 multipart upload. Files ≥ 5 MB should set this; the server returns an array of pre-signed UploadPart URLs instead of a single PUT URL.',
  })
  @IsOptional()
  @IsBoolean()
  multipart?: boolean;
}

export class UploadInitPartDto {
  @ApiProperty({ minimum: 1, maximum: 10_000 })
  partNumber!: number;

  @ApiProperty({ format: 'uri' })
  signedUrl!: string;
}

export class UploadInitResponseDto {
  @ApiProperty({ format: 'uuid' })
  uploadId!: string;

  @ApiProperty({
    description:
      'True when the response carries a ``parts`` array instead of a single ``signedUrl``. Files < 5 MB always receive the single-shot form.',
  })
  multipart!: boolean;

  @ApiProperty({
    required: false,
    description: 'Single-shot PUT URL. Present iff ``multipart === false``.',
  })
  signedUrl?: string;

  @ApiProperty({
    required: false,
    type: [UploadInitPartDto],
    description: 'Pre-signed UploadPart URLs. Present iff ``multipart === true``.',
  })
  parts?: UploadInitPartDto[];

  @ApiProperty({ format: 'uri', required: false })
  publicUrl?: string;

  @ApiProperty()
  s3Key?: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}

export class UploadCompletePartDto {
  @ApiProperty({ minimum: 1, maximum: 10_000 })
  partNumber!: number;

  @ApiProperty()
  etag!: string;
}

export class UploadCompleteDto {
  @ApiProperty({
    required: false,
    type: [UploadCompletePartDto],
    description:
      'Required for multipart uploads — each successful UploadPart response carried an ETag header; pass them back so the server can issue CompleteMultipartUpload.',
  })
  @IsOptional()
  parts?: UploadCompletePartDto[];
}
