import { Module } from '@nestjs/common';
import { LtiAdminController } from './lti-admin.controller';
import { LtiController } from './lti.controller';
import { LtiService } from './lti.service';

@Module({
  controllers: [LtiController, LtiAdminController],
  providers: [LtiService],
  exports: [LtiService],
})
export class LtiModule {}
