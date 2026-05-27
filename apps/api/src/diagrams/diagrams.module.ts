import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { SharedFoldersModule } from '../shared-folders/shared-folders.module';
import { DiagramsController } from './diagrams.controller';

@Module({
  imports: [BudgetModule, SharedFoldersModule],
  controllers: [DiagramsController],
})
export class DiagramsModule {}
