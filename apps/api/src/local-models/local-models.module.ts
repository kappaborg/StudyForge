import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LocalModelsController } from './local-models.controller';
import { LocalModelsService } from './local-models.service';

@Module({
  imports: [PrismaModule],
  controllers: [LocalModelsController],
  providers: [LocalModelsService],
  exports: [LocalModelsService],
})
export class LocalModelsModule {}
