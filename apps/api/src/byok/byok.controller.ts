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
import { Idempotent } from '../common/idempotency.interceptor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { ByokService } from './byok.service';
import { ByokCreateDto } from './dto/byok-create.dto';
import { ByokResponseDto } from './dto/byok-response.dto';

@ApiTags('byok')
@Controller('me/byok')
export class ByokController {
  constructor(private readonly byok: ByokService) {}

  @Get()
  @ApiOperation({ summary: 'List active BYOK keys (last4 + provider only)' })
  list(@CurrentUser() user: AuthContext): Promise<ByokResponseDto[]> {
    return this.byok.list(user.userId);
  }

  @Post()
  @Idempotent()
  @HttpCode(201)
  @ApiOperation({ summary: 'Add a BYOK key (envelope-encrypted at rest)' })
  add(
    @CurrentUser() user: AuthContext,
    @Body() dto: ByokCreateDto,
  ): Promise<ByokResponseDto> {
    return this.byok.create(user.tenantId, user.userId, dto, user.email);
  }

  @Delete(':id')
  @Idempotent()
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a BYOK key' })
  async revoke(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.byok.revoke(user.userId, id);
  }
}
