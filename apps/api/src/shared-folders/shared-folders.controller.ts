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
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { SharedFoldersService } from './shared-folders.service';

class PublishDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}

class SubscribeDto {
  @IsString()
  @MaxLength(32)
  code!: string;
}

@ApiTags('shared-folders')
@Controller()
export class SharedFoldersController {
  constructor(private readonly shared: SharedFoldersService) {}

  // ── publisher side ────────────────────────────────────────────────────────

  @Get('folders/:id/share')
  @ApiOperation({ summary: 'Get the existing share (code, title) for a folder, if any.' })
  async getShare(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return (await this.shared.getByFolder(user.tenantId, id)) ?? null;
  }

  @Post('folders/:id/share')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Publish (or re-publish) a folder under a fresh share code. Re-publishing rotates the code.',
  })
  async publish(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PublishDto,
  ) {
    return this.shared.publish(user.tenantId, user.userId, id, dto);
  }

  @Delete('folders/:id/share')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unpublish a folder. Existing subscriptions stop resolving.' })
  async unpublish(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.shared.unpublish(user.tenantId, user.userId, id);
  }

  // ── subscriber side ───────────────────────────────────────────────────────

  @Post('shared/subscribe')
  @HttpCode(200)
  @ApiOperation({ summary: 'Subscribe to a published folder by its share code.' })
  async subscribe(
    @CurrentUser() user: AuthContext,
    @Body() dto: SubscribeDto,
  ) {
    return this.shared.subscribeByCode(user.userId, dto.code);
  }

  @Get('shared/subscriptions')
  @ApiOperation({ summary: 'List the current user’s active subscriptions.' })
  async listSubscriptions(@CurrentUser() user: AuthContext) {
    return { subscriptions: await this.shared.listSubscriptions(user.userId) };
  }

  @Delete('shared/subscriptions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unsubscribe from a shared folder.' })
  async unsubscribe(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.shared.unsubscribe(user.userId, id);
  }
}
