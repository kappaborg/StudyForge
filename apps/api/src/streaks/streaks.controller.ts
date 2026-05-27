import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { StreaksService } from './streaks.service';

@ApiTags('streaks')
@Controller('streaks')
export class StreaksController {
  constructor(private readonly streaks: StreaksService) {}

  @Get('me')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Current + longest learning streak for the active user. Decays to 0 client-visible when the user has missed > 1 day.',
  })
  async me(@CurrentUser() user: AuthContext) {
    return this.streaks.getForUser(user.userId);
  }
}
