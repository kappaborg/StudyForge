import { Module } from '@nestjs/common';
import { ArtifactCacheService } from './artifact-cache.service';
import { ContentHashService } from './content-hash.service';

@Module({
  providers: [ContentHashService, ArtifactCacheService],
  exports: [ContentHashService, ArtifactCacheService],
})
export class SharingModule {}
