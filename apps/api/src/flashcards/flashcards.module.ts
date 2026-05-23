import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { SharingModule } from '../sharing/sharing.module';
import { FlashcardsController } from './flashcards.controller';

@Module({
  imports: [SharingModule, BudgetModule],
  controllers: [FlashcardsController],
})
export class FlashcardsModule {}
