import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DemoSeederModule } from '../demo/demo-seeder.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [PrismaModule, DemoSeederModule],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
