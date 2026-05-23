import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsHexColor, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { ProblemException } from '../common/problem';
import { isUuid } from '../common/uuid';
import { FoldersService, type FolderDto } from './folders.service';

class CreateFolderDto {
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsOptional() @IsHexColor() color?: string;
}

class UpdateFolderDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) name?: string;
  @IsOptional() @IsHexColor() color?: string;
}

class MoveDocumentDto {
  @IsString() folderId!: string;
}

@ApiTags('folders')
@Controller()
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Get('folders')
  @HttpCode(200)
  @ApiOperation({ summary: 'List folders for the tenant (Inbox + user folders + Trash)' })
  list(@CurrentUser() user: AuthContext): Promise<FolderDto[]> {
    return this.folders.list(user.tenantId);
  }

  @Post('folders')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a new materials folder' })
  create(
    @CurrentUser() user: AuthContext,
    @Body() dto: CreateFolderDto,
  ): Promise<FolderDto> {
    return this.folders.create(user.tenantId, dto.name, dto.color);
  }

  @Patch('folders/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rename or recolor a folder' })
  update(
    @CurrentUser() user: AuthContext,
    @Param('id') id: string,
    @Body() dto: UpdateFolderDto,
  ): Promise<FolderDto> {
    if (!isUuid(id)) {
      throw new ProblemException({
        status: 404,
        code: 'folders.not-found',
        title: 'Folder not found',
      });
    }
    return this.folders.rename(user.tenantId, id, dto.name, dto.color);
  }

  @Delete('folders/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an empty materials folder' })
  async remove(
    @CurrentUser() user: AuthContext,
    @Param('id') id: string,
  ): Promise<void> {
    if (!isUuid(id)) {
      throw new ProblemException({
        status: 404,
        code: 'folders.not-found',
        title: 'Folder not found',
      });
    }
    await this.folders.remove(user.tenantId, id);
  }

  @Post('documents/:id/move')
  @HttpCode(204)
  @ApiOperation({ summary: 'Move a document to another folder' })
  async move(
    @CurrentUser() user: AuthContext,
    @Param('id') id: string,
    @Body() dto: MoveDocumentDto,
  ): Promise<void> {
    if (!isUuid(id) || !isUuid(dto.folderId)) {
      throw new ProblemException({
        status: 404,
        code: 'documents.not-found',
        title: 'Document or folder not found',
      });
    }
    await this.folders.moveDocument(user.tenantId, id, dto.folderId);
  }
}
