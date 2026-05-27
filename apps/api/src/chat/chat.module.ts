import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { SharedFoldersModule } from '../shared-folders/shared-folders.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [BudgetModule, PrismaModule, SharedFoldersModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
