import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { BudgetModule } from './budget/budget.module';
import { ByokModule } from './byok/byok.module';
import { ChatModule } from './chat/chat.module';
import { ChunksModule } from './chunks/chunks.module';
import { CommonModule } from './common/common.module';
import { ConceptsModule } from './concepts/concepts.module';
import { DiagramsModule } from './diagrams/diagrams.module';
import { DiffModule } from './diff/diff.module';
import { DocumentsModule } from './documents/documents.module';
import { ExamScopesModule } from './exam-scopes/exam-scopes.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { FlashcardsModule } from './flashcards/flashcards.module';
import { FoldersModule } from './folders/folders.module';
import { HealthModule } from './health/health.module';
import { LocalModelsModule } from './local-models/local-models.module';
import { InstructorModule } from './instructor/instructor.module';
import { LtiModule } from './lti/lti.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { PresentationsModule } from './presentations/presentations.module';
import { ProgressModule } from './progress/progress.module';
import { QuizzesModule } from './quizzes/quizzes.module';
import { RoadmapsModule } from './roadmaps/roadmaps.module';
import { SearchModule } from './search/search.module';
import { SharedFoldersModule } from './shared-folders/shared-folders.module';
import { SharingModule } from './sharing/sharing.module';
import { StreaksModule } from './streaks/streaks.module';
import { UploadsModule } from './uploads/uploads.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    CommonModule,
    AuthModule,
    HealthModule,
    UploadsModule,
    ByokModule,
    DocumentsModule,
    ChunksModule,
    ChatModule,
    FlashcardsModule,
    QuizzesModule,
    RoadmapsModule,
    ConceptsModule,
    DiagramsModule,
    ProgressModule,
    SharingModule,
    NotificationsModule,
    DiffModule,
    SearchModule,
    InstructorModule,
    PresentationsModule,
    BudgetModule,
    FeatureFlagsModule,
    LtiModule,
    FoldersModule,
    LocalModelsModule,
    ExamScopesModule,
    SharedFoldersModule,
    StreaksModule,
  ],
})
export class AppModule {}
