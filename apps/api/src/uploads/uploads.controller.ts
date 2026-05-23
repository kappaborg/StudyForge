import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { Idempotent } from '../common/idempotency.interceptor';
import { UploadInitDto, UploadInitResponseDto } from './dto/upload-init.dto';
import { UploadsService } from './uploads.service';

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
  @ApiOperation({ summary: 'Mark upload complete and trigger ingest' })
  async complete(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) uploadId: string,
  ): Promise<{ uploadId: string; state: string; documentId?: string; chunkCount?: number }> {
    return this.uploads.complete(user.tenantId, user.userId, uploadId);
  }
}
