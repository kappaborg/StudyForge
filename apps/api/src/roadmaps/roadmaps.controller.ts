import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { CoursesService } from '../common/courses.service';
import { ProblemException } from '../common/problem';
import { enforceBudget } from '../budget/budget-guard';
import { BudgetService } from '../budget/budget.service';
import { isUuid } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';
import { SharedFoldersService } from '../shared-folders/shared-folders.service';
import { ArtifactCacheService } from '../sharing/artifact-cache.service';

class GenerateRoadmapDto {
  @IsOptional() @IsString() courseId?: string;
  @IsOptional() @IsString() folderId?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) chapters?: number[];
  @IsOptional() @IsString() @MaxLength(400) query?: string;
  @IsOptional() @IsInt() @Min(1) @Max(16) weeks?: number;
}

interface MilestoneDto {
  id: string;
  weekIndex: number;
  ordinal: number;
  title: string;
  effortMin: number;
  status: string;
}

interface RoadmapDto {
  id: string;
  title: string;
  weeks: number;
  milestones: MilestoneDto[];
}

const AI_WORKER_URL = process.env['AI_WORKER_URL'] ?? 'http://localhost:8001';
const DEMO_COURSE_ID = '00000000-0000-0000-0000-00000000c0c0';

interface WorkerMilestone {
  title: string;
  week_index: number;
  ordinal: number;
  effort_min: number;
}

@ApiTags('roadmaps')
@Controller()
export class RoadmapsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ArtifactCacheService,
    private readonly budget: BudgetService,
    private readonly courses: CoursesService,
    private readonly shared: SharedFoldersService,
  ) {}

  @Post('roadmaps/generate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate a weekly study roadmap from materials' })
  async generate(
    @CurrentUser() user: AuthContext,
    @Body() dto: GenerateRoadmapDto,
  ): Promise<RoadmapDto> {
    await enforceBudget(this.budget, user.tenantId);
    const persistCourseId = await this.ensureCourse(user.tenantId, dto.courseId);

    // Course-shared artifact cache: reuse a roadmap from a peer course
    // with the same content hash.
    const donor = await this.cache.maybeShareFrom(user.tenantId, persistCourseId);
    if (donor) {
      const canonical = await this.prisma.roadmap.findFirst({
        where: { courseId: donor.canonicalCourseId, deletedAt: null },
        include: {
          milestones: { orderBy: [{ weekIndex: 'asc' }, { ordinal: 'asc' }] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (canonical) return roadmapToDto(canonical);
    }

    const retrievalCourseId = isUuid(dto.courseId) ? dto.courseId : null;
    const retrievalFolderId = isUuid(dto.folderId) ? dto.folderId : null;
    const allowedFolderIds = await this.shared.accessibleFolderIds(user.userId);
    const body = {
      tenant_id: user.tenantId,
      user_id: user.userId,
      course_id: retrievalCourseId,
      folder_id: retrievalFolderId,
      ...(dto.chapters && dto.chapters.length > 0 ? { chapters: dto.chapters } : {}),
      ...(allowedFolderIds.length > 0 ? { allowed_folder_ids: allowedFolderIds } : {}),
      query: dto.query ?? '',
      weeks: dto.weeks ?? 4,
    };
    const res = await fetch(`${AI_WORKER_URL}/v1/roadmaps/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new ProblemException({
        status: 502,
        code: 'roadmaps.upstream-failed',
        title: 'Roadmap pipeline failed',
        detail,
      });
    }
    const json = (await res.json()) as {
      course_id: string;
      title: string;
      weeks: number;
      milestones: WorkerMilestone[];
    };

    const roadmap = await this.prisma.roadmap.create({
      data: {
        courseId: persistCourseId,
        userId: user.userId,
        title: json.title,
        weeks: json.weeks,
        milestones: {
          create: json.milestones.map((m) => ({
            weekIndex: m.week_index,
            ordinal: m.ordinal,
            title: m.title,
            effortMin: m.effort_min,
          })),
        },
      },
      include: {
        milestones: { orderBy: [{ weekIndex: 'asc' }, { ordinal: 'asc' }] },
      },
    });

    await this.cache.registerCanonical(user.tenantId, persistCourseId);

    return roadmapToDto(roadmap);
  }

  @Get('courses/:courseId/roadmaps')
  @HttpCode(200)
  @ApiOperation({ summary: 'List roadmaps for a course' })
  async list(
    @CurrentUser() user: AuthContext,
    @Param('courseId') courseId: string,
  ): Promise<{ roadmaps: Array<{ id: string; title: string; weeks: number; milestoneCount: number; createdAt: string }> }> {
    const resolved = await this.ensureCourse(user.tenantId, courseId);
    const roadmaps = await this.prisma.roadmap.findMany({
      where: { courseId: resolved, deletedAt: null },
      include: { _count: { select: { milestones: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      roadmaps: roadmaps.map((r) => ({
        id: r.id,
        title: r.title,
        weeks: r.weeks,
        milestoneCount: r._count.milestones,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  @Get('roadmaps/:roadmapId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get a roadmap with its milestones' })
  async getRoadmap(
    @CurrentUser() user: AuthContext,
    @Param('roadmapId') roadmapId: string,
  ): Promise<RoadmapDto> {
    if (!isUuid(roadmapId)) {
      throw new ProblemException({
        status: 404,
        code: 'roadmaps.not-found',
        title: 'Roadmap not found',
      });
    }
    const roadmap = await this.prisma.roadmap.findFirst({
      where: { id: roadmapId, deletedAt: null, course: { tenantId: user.tenantId } },
      include: {
        milestones: { orderBy: [{ weekIndex: 'asc' }, { ordinal: 'asc' }] },
      },
    });
    if (!roadmap) {
      throw new ProblemException({
        status: 404,
        code: 'roadmaps.not-found',
        title: 'Roadmap not found',
      });
    }
    return roadmapToDto(roadmap);
  }

  private async ensureCourse(tenantId: string, explicitCourseId?: string): Promise<string> {
    return this.courses.ensureForTenant(tenantId, explicitCourseId);
  }
}

function roadmapToDto(roadmap: {
  id: string;
  title: string;
  weeks: number;
  milestones: Array<{
    id: string;
    weekIndex: number;
    ordinal: number;
    title: string;
    effortMin: number;
    status: string;
  }>;
}): RoadmapDto {
  return {
    id: roadmap.id,
    title: roadmap.title,
    weeks: roadmap.weeks,
    milestones: roadmap.milestones.map((m) => ({
      id: m.id,
      weekIndex: m.weekIndex,
      ordinal: m.ordinal,
      title: m.title,
      effortMin: m.effortMin,
      status: m.status,
    })),
  };
}
