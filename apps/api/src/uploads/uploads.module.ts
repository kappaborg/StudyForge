import { Module } from '@nestjs/common';
import { FoldersModule } from '../folders/folders.module';
import { LocalModelsModule } from '../local-models/local-models.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SearchModule } from '../search/search.module';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  imports: [NotificationsModule, SearchModule, FoldersModule, LocalModelsModule],
  controllers: [UploadsController],
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
