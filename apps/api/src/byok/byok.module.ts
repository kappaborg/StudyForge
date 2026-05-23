import { Module } from '@nestjs/common';
import { ByokController } from './byok.controller';
import { ByokService } from './byok.service';

@Module({
  controllers: [ByokController],
  providers: [ByokService],
  exports: [ByokService],
})
export class ByokModule {}
