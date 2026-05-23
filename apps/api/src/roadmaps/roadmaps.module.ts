import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { SharingModule } from '../sharing/sharing.module';
import { RoadmapsController } from './roadmaps.controller';

@Module({
  imports: [SharingModule, BudgetModule],
  controllers: [RoadmapsController],
})
export class RoadmapsModule {}
