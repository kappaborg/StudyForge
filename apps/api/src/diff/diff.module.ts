import { Module } from '@nestjs/common';
import { DiffController } from './diff.controller';

@Module({ controllers: [DiffController] })
export class DiffModule {}
