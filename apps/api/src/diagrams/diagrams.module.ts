import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { DiagramsController } from './diagrams.controller';

@Module({
  imports: [BudgetModule],
  controllers: [DiagramsController],
})
export class DiagramsModule {}
