import { Module } from '@nestjs/common';
import { InstructorController } from './instructor.controller';

@Module({ controllers: [InstructorController] })
export class InstructorModule {}
