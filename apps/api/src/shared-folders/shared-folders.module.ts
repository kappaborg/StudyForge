import { Module } from '@nestjs/common';
import { SharedFoldersController } from './shared-folders.controller';
import { SharedFoldersService } from './shared-folders.service';

@Module({
  controllers: [SharedFoldersController],
  providers: [SharedFoldersService],
  exports: [SharedFoldersService],
})
export class SharedFoldersModule {}
