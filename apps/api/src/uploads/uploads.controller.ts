import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { Idempotent } from '../common/idempotency.interceptor';
import {
  UploadCompleteDto,
  UploadInitDto,
  UploadInitResponseDto,
} from './dto/upload-init.dto';
import { UploadsService } from './uploads.service';

class YouTubeIngestDto {
  @IsString()
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsUUID()
  folderId?: string;
}

class TextIngestDto {
  @IsString()
  @MaxLength(400)
  title!: string;

  @IsString()
  @MaxLength(2_000_000)
  text!: string;

  @IsOptional()
  @IsUUID()
  folderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  sourceUrl?: string;
}

@ApiTags('uploads')
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('init')
  @Idempotent()
  @HttpCode(200)
  @ApiOperation({ summary: 'Reserve + sign upload URL' })
  async init(
    @CurrentUser() user: AuthContext,
    @Body() dto: UploadInitDto,
  ): Promise<UploadInitResponseDto> {
    return this.uploads.init(user.tenantId, user.userId, user.email, dto);
  }

  @Post(':id/complete')
  @Idempotent()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Mark upload complete and trigger ingest. For multipart uploads, pass the parts array returned from each UploadPart response.',
  })
  async complete(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) uploadId: string,
    @Body() dto: UploadCompleteDto = {},
  ): Promise<{ uploadId: string; state: string; documentId?: string; chunkCount?: number }> {
    return this.uploads.complete(user.tenantId, user.userId, uploadId, {
      parts: dto.parts,
    });
  }

  @Post('youtube')
  @Idempotent()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Ingest a YouTube video by URL. Pulls captions (manual or auto-generated), chunks + embeds, lands a Document in the chosen folder.',
  })
  async youtube(
    @CurrentUser() user: AuthContext,
    @Body() dto: YouTubeIngestDto,
  ): Promise<{
    uploadId: string;
    state: string;
    documentId: string;
    chunkCount: number;
    title: string;
  }> {
    return this.uploads.ingestYoutube(user.tenantId, user.userId, user.email, dto);
  }

  @Post('text')
  @Idempotent()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Ingest a plain-text payload (browser-extension capture, copied selection, etc.). Lands a Document with the supplied title in the chosen folder.',
  })
  async text(
    @CurrentUser() user: AuthContext,
    @Body() dto: TextIngestDto,
  ): Promise<{
    uploadId: string;
    state: string;
    documentId: string;
    chunkCount: number;
    title: string;
  }> {
    return this.uploads.ingestText(user.tenantId, user.userId, user.email, dto);
  }
}
