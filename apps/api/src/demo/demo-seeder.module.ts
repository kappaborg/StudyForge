import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FoldersModule } from '../folders/folders.module';
import { DemoSeederService } from './demo-seeder.service';

/**
 * CoursesService is provided by the global ``CommonModule`` so it doesn't
 * need to be imported here.
 */
@Module({
  imports: [PrismaModule, FoldersModule],
  providers: [DemoSeederService],
  exports: [DemoSeederService],
})
export class DemoSeederModule {}
