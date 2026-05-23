import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, Min } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { LocalModelsService } from './local-models.service';

class CreateLocalModelDto {
  @IsString()
  folderId!: string;
}

class MarkBuiltDto {
  @IsInt()
  @Min(0)
  chunkCount!: number;

  @IsInt()
  @Min(0)
  sizeBytes!: number;

  @IsString()
  embedderId!: string;

  @IsInt()
  @Min(1)
  embedderDim!: number;
}

@ApiTags('local-models')
@Controller('local-models')
export class LocalModelsController {
  constructor(private readonly service: LocalModelsService) {}

  @Get()
  @ApiOperation({ summary: "List the current user's local (offline) models" })
  async list(@CurrentUser() user: AuthContext) {
    return { models: await this.service.list(user.tenantId, user.userId) };
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Register (or reset) a local-model build for a folder. Returns the registry row to drive the client-side build.',
  })
  async create(
    @CurrentUser() user: AuthContext,
    @Body() dto: CreateLocalModelDto,
  ) {
    return this.service.createOrReset(user.tenantId, user.userId, dto.folderId);
  }

  @Get(':id/chunks')
  @ApiOperation({
    summary: 'Stream the chunk bundle for client-side embedding',
  })
  async chunks(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return { chunks: await this.service.listChunks(user.tenantId, user.userId, id) };
  }

  @Post(':id/mark-built')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Client signals build completion + reports index stats',
  })
  async markBuilt(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MarkBuiltDto,
  ) {
    return this.service.markBuilt(user.tenantId, user.userId, id, dto);
  }

  @Post(':id/mark-failed')
  @HttpCode(200)
  @ApiOperation({ summary: 'Client signals a failed build' })
  async markFailed(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.markFailed(user.tenantId, user.userId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a local-model registry entry' })
  async remove(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.service.remove(user.tenantId, user.userId, id);
  }
}
