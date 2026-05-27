import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SharedFoldersModule } from '../shared-folders/shared-folders.module';
import { SharingModule } from '../sharing/sharing.module';
import { StreaksModule } from '../streaks/streaks.module';
import { FlashcardsController } from './flashcards.controller';
import { SrsService } from './srs.service';

@Module({
  imports: [SharingModule, BudgetModule, PrismaModule, SharedFoldersModule, StreaksModule],
  controllers: [FlashcardsController],
  providers: [SrsService],
  exports: [SrsService],
})
export class FlashcardsModule {}
