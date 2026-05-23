import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { SearchModule } from '../search/search.module';
import { SharingModule } from '../sharing/sharing.module';
import { ConceptsController } from './concepts.controller';

@Module({
  imports: [SharingModule, SearchModule, BudgetModule],
  controllers: [ConceptsController],
})
export class ConceptsModule {}
