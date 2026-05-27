import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { SharedFoldersModule } from '../shared-folders/shared-folders.module';
import { PresentationsController } from './presentations.controller';

@Module({
  imports: [BudgetModule, SharedFoldersModule],
  controllers: [PresentationsController],
})
export class PresentationsModule {}
