import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ExamScopesController } from './exam-scopes.controller';
import { ExamScopesService } from './exam-scopes.service';
import { ScopeSharesController } from './scope-shares.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ExamScopesController, ScopeSharesController],
  providers: [ExamScopesService],
  exports: [ExamScopesService],
})
export class ExamScopesModule {}
