import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { SharedFoldersModule } from '../shared-folders/shared-folders.module';
import { SharingModule } from '../sharing/sharing.module';
import { RoadmapsController } from './roadmaps.controller';

@Module({
  imports: [SharingModule, BudgetModule, SharedFoldersModule],
  controllers: [RoadmapsController],
})
export class RoadmapsModule {}
