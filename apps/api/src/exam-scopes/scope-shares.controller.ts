import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { ExamScopesService } from './exam-scopes.service';

class AcceptShareDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  token!: string;

  @IsUUID()
  folderId!: string;
}

/**
 * Accept-side of the study-group share flow. The publish/revoke
 * endpoints live on ``ExamScopesController`` (under ``/exam-scopes/:id``
 * because they're owner-only) — here we handle the OTHER half: any
 * authenticated user can preview a token and fork it into their tenant.
 */
@ApiTags('exam-scopes')
@Controller('shared/scopes')
export class ScopeSharesController {
  constructor(private readonly service: ExamScopesService) {}

  @Get('preview/:token')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Read-only preview of a shared scope. Shows the structure (chapters / topics / mode / exam date) so the acceptor knows what they’re about to fork.',
  })
  async preview(@Param('token') token: string) {
    return this.service.previewByToken(token);
  }

  @Post('accept')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Fork a shared scope into a folder the caller owns. Returns the new (per-acceptor) ExamScope row.',
  })
  async accept(
    @CurrentUser() user: AuthContext,
    @Body() dto: AcceptShareDto,
  ) {
    return this.service.acceptByToken(user.tenantId, user.userId, dto.token, dto.folderId);
  }
}
