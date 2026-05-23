import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { PresentationsController } from './presentations.controller';

@Module({
  imports: [BudgetModule],
  controllers: [PresentationsController],
})
export class PresentationsModule {}
