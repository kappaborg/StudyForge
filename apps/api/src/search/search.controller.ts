import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService, type SearchHit } from './search.service';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('reindex')
  @HttpCode(200)
  @ApiOperation({ summary: 'One-shot backfill: reindex every document + concept set for this tenant' })
  async reindex(
    @CurrentUser() user: AuthContext,
  ): Promise<{ documents: number; conceptCourses: number }> {
    const docs = await this.prisma.document.findMany({
      where: { tenantId: user.tenantId, deletedAt: null },
      select: { id: true },
    });
    await Promise.all(docs.map((d) => this.search.indexDocument(d.id)));

    const conceptCourseIds = await this.prisma.concept.groupBy({
      by: ['courseId'],
      where: { course: { tenantId: user.tenantId } },
    });
    await Promise.all(
      conceptCourseIds.map((row) =>
        this.search.indexConceptsForCourse(row.courseId, user.tenantId),
      ),
    );

    return {
      documents: docs.length,
      conceptCourses: conceptCourseIds.length,
    };
  }

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'Cross-index search (documents · chunks · concepts) for the tenant' })
  async query(
    @CurrentUser() user: AuthContext,
    @Query('q') q: string,
    @Query('limit') limitStr?: string,
  ): Promise<{ hits: SearchHit[] }> {
    const query = (q ?? '').trim();
    if (query.length === 0) return { hits: [] };
    const limit = limitStr ? Math.max(1, Math.min(20, Number(limitStr) || 10)) : 10;
    const hits = await this.search.search({ query, tenantId: user.tenantId, limit });
    return { hits };
  }
}
