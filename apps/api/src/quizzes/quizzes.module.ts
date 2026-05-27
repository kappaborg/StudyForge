import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { SharedFoldersModule } from '../shared-folders/shared-folders.module';
import { LtiModule } from '../lti/lti.module';
import { SharingModule } from '../sharing/sharing.module';
import { StreaksModule } from '../streaks/streaks.module';
import { QuizzesController } from './quizzes.controller';

@Module({
  imports: [SharingModule, BudgetModule, LtiModule, SharedFoldersModule, StreaksModule],
  controllers: [QuizzesController],
})
export class QuizzesModule {}
