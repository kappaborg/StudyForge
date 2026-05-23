import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
}

export class UploadInitResponseDto {
  @ApiProperty({ format: 'uuid' })
  uploadId!: string;

  @ApiProperty({ format: 'uri', description: 'Browser-reachable signed URL' })
  signedUrl!: string;

  @ApiProperty({ format: 'uri', required: false })
  publicUrl?: string;

  @ApiProperty()
  s3Key?: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}
