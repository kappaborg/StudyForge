import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { CoursesService } from '../common/courses.service';
import { ProblemException } from '../common/problem';
import { enforceBudget } from '../budget/budget-guard';
import { BudgetService } from '../budget/budget.service';
import { isUuid } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';
import { SharedFoldersService } from '../shared-folders/shared-folders.service';
import { SearchService } from '../search/search.service';
import { ArtifactCacheService } from '../sharing/artifact-cache.service';

class ExtractConceptsDto {
  @IsOptional() @IsString() courseId?: string;
  @IsOptional() @IsString() folderId?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) chapters?: number[];
  @IsOptional() @IsInt() @Min(3) @Max(40) maxConcepts?: number;
}

interface ConceptDto {
  id: string;
  label: string;
  description: string | null;
  difficulty: number;
  chunkIds: string[];
}

interface ConceptEdgeDto {
  fromId: string;
  toId: string;
  kind: string;
  weight: number;
}

interface ConceptGraphDto {
  courseId: string;
  concepts: ConceptDto[];
  edges: ConceptEdgeDto[];
}

const AI_WORKER_URL = process.env['AI_WORKER_URL'] ?? 'http://localhost:8001';
const DEMO_COURSE_ID = '00000000-0000-0000-0000-00000000c0c0';

interface WorkerConcept {
  id: string;
  label: string;
  description: string | null;
  difficulty: number;
  chunk_ids: string[];
}

interface WorkerEdge {
  from_id: string;
  to_id: string;
  kind: string;
  weight: number;
}

@ApiTags('concepts')
@Controller()
export class ConceptsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ArtifactCacheService,
    private readonly search: SearchService,
    private readonly budget: BudgetService,
    private readonly courses: CoursesService,
    private readonly shared: SharedFoldersService,
  ) {}

  @Post('concepts/extract')
  @HttpCode(200)
  @ApiOperation({ summary: 'Extract concept graph from course materials' })
  async extract(
    @CurrentUser() user: AuthContext,
    @Body() dto: ExtractConceptsDto,
  ): Promise<ConceptGraphDto> {
    await enforceBudget(this.budget, user.tenantId);
    const persistCourseId = await this.ensureCourse(user.tenantId, dto.courseId);

    // Course-shared artifact cache: clone the concept graph from a peer
    // course with the same content hash. Edges + concepts get fresh row
    // ids so we don't violate the (courseId, fromId, toId) FK contract.
    const donor = await this.cache.maybeShareFrom(user.tenantId, persistCourseId);
    if (donor) {
      const cloned = await this.cloneConceptGraph(donor.canonicalCourseId, persistCourseId);
      if (cloned) return cloned;
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
      max_concepts: dto.maxConcepts ?? 12,
    };
    const res = await fetch(`${AI_WORKER_URL}/v1/semantic/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new ProblemException({
        status: 502,
        code: 'concepts.upstream-failed',
        title: 'Concept extraction failed',
        detail,
      });
    }
    const json = (await res.json()) as {
      course_id: string;
      concepts: WorkerConcept[];
      edges: WorkerEdge[];
    };

    // Wipe + re-write the graph for this course. Phase 2 keeps a single
    // active graph per course; revision history lives elsewhere when we
    // need it. ``deleteMany`` cascades to ConceptEdge via the schema.
    await this.prisma.$transaction([
      this.prisma.conceptEdge.deleteMany({ where: { courseId: persistCourseId } }),
      this.prisma.concept.deleteMany({ where: { courseId: persistCourseId } }),
    ]);

    // Worker-emitted ids are real UUIDs — pass them straight through so
    // the edge writes can reference them.
    if (json.concepts.length > 0) {
      await this.prisma.concept.createMany({
        data: json.concepts.map((c) => ({
          id: c.id,
          courseId: persistCourseId,
          label: c.label,
          description: c.description,
          difficulty: c.difficulty,
        })),
      });
    }
    if (json.edges.length > 0) {
      await this.prisma.conceptEdge.createMany({
        data: json.edges.map((e) => ({
          courseId: persistCourseId,
          fromId: e.from_id,
          toId: e.to_id,
          kind: e.kind as
            | 'prerequisite_of'
            | 'related_to'
            | 'example_of'
            | 'derived_from'
            | 'contradicts',
          weight: e.weight,
        })),
        skipDuplicates: true,
      });
    }

    await this.cache.registerCanonical(user.tenantId, persistCourseId);
    void this.search.indexConceptsForCourse(persistCourseId, user.tenantId);

    return {
      courseId: persistCourseId,
      concepts: json.concepts.map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description,
        difficulty: c.difficulty,
        chunkIds: c.chunk_ids,
      })),
      edges: json.edges.map((e) => ({
        fromId: e.from_id,
        toId: e.to_id,
        kind: e.kind,
        weight: e.weight,
      })),
    };
  }

  /** Clone an existing concept graph from ``sourceCourseId`` into
   *  ``targetCourseId``. Concept ids are reissued to honour the per-row
   *  PK and edges re-mapped against the new ids. Returns the cloned
   *  graph payload or ``null`` if the source had no concepts. */
  private async cloneConceptGraph(
    sourceCourseId: string,
    targetCourseId: string,
  ): Promise<ConceptGraphDto | null> {
    const [sourceConcepts, sourceEdges] = await Promise.all([
      this.prisma.concept.findMany({
        where: { courseId: sourceCourseId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.conceptEdge.findMany({
        where: { courseId: sourceCourseId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    if (sourceConcepts.length === 0) return null;

    await this.prisma.$transaction([
      this.prisma.conceptEdge.deleteMany({ where: { courseId: targetCourseId } }),
      this.prisma.concept.deleteMany({ where: { courseId: targetCourseId } }),
    ]);

    const remap = new Map<string, string>();
    for (const c of sourceConcepts) {
      remap.set(c.id, crypto.randomUUID());
    }
    await this.prisma.concept.createMany({
      data: sourceConcepts.map((c) => ({
        id: remap.get(c.id)!,
        courseId: targetCourseId,
        label: c.label,
        description: c.description,
        difficulty: c.difficulty,
      })),
    });
    const validEdges = sourceEdges.filter(
      (e) => remap.has(e.fromId) && remap.has(e.toId),
    );
    if (validEdges.length > 0) {
      await this.prisma.conceptEdge.createMany({
        data: validEdges.map((e) => ({
          courseId: targetCourseId,
          fromId: remap.get(e.fromId)!,
          toId: remap.get(e.toId)!,
          kind: e.kind,
          weight: e.weight,
        })),
        skipDuplicates: true,
      });
    }

    return {
      courseId: targetCourseId,
      concepts: sourceConcepts.map((c) => ({
        id: remap.get(c.id)!,
        label: c.label,
        description: c.description,
        difficulty: c.difficulty,
        chunkIds: [],
      })),
      edges: validEdges.map((e) => ({
        fromId: remap.get(e.fromId)!,
        toId: remap.get(e.toId)!,
        kind: e.kind,
        weight: e.weight,
      })),
    };
  }

  @Get('courses/:courseId/concepts')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get the concept graph for a course' })
  async list(
    @CurrentUser() user: AuthContext,
    @Param('courseId') courseId: string,
  ): Promise<ConceptGraphDto> {
    const resolved = await this.ensureCourse(user.tenantId, courseId);
    const [concepts, edges] = await Promise.all([
      this.prisma.concept.findMany({
        where: { courseId: resolved },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.conceptEdge.findMany({
        where: { courseId: resolved },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      courseId: resolved,
      concepts: concepts.map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description,
        difficulty: c.difficulty,
        chunkIds: [], // Persisted chunk refs land with the graph-view work.
      })),
      edges: edges.map((e) => ({
        fromId: e.fromId,
        toId: e.toId,
        kind: e.kind,
        weight: e.weight,
      })),
    };
  }

  private async ensureCourse(tenantId: string, explicitCourseId?: string): Promise<string> {
    return this.courses.ensureForTenant(tenantId, explicitCourseId);
  }
}
