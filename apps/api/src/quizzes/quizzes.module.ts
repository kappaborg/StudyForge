import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { LtiModule } from '../lti/lti.module';
import { SharingModule } from '../sharing/sharing.module';
import { QuizzesController } from './quizzes.controller';

@Module({
  imports: [SharingModule, BudgetModule, LtiModule],
  controllers: [QuizzesController],
})
export class QuizzesModule {}
