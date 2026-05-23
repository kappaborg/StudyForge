import { Module } from '@nestjs/common';
import { FoldersModule } from '../folders/folders.module';
import { LocalModelsModule } from '../local-models/local-models.module';
import { DocumentsController } from './documents.controller';

@Module({
  imports: [FoldersModule, LocalModelsModule],
  controllers: [DocumentsController],
})
export class DocumentsModule {}
