import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { BudgetService } from './budget.service';

@ApiTags('budget')
@Controller('me')
export class BudgetController {
  constructor(private readonly budget: BudgetService) {}

  @Get('budget')
  @HttpCode(200)
  @ApiOperation({ summary: 'Current daily/monthly AI-request budget for this tenant' })
  async snapshot(@CurrentUser() user: AuthContext) {
    return this.budget.snapshot(user.tenantId);
  }
}
