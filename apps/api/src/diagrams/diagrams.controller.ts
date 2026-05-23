import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { enforceBudget } from '../budget/budget-guard';
import { BudgetService } from '../budget/budget.service';
import { ProblemException } from '../common/problem';
import { isUuid } from '../common/uuid';

const KINDS = ['flowchart', 'mindmap', 'sequence'] as const;
type DiagramKind = (typeof KINDS)[number];

class GenerateDiagramDto {
  @IsOptional() @IsString() courseId?: string;
  @IsOptional() @IsString() folderId?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) chapters?: number[];
  @IsOptional() @IsString() @MaxLength(400) query?: string;
  @IsOptional() @IsIn(KINDS) kind?: DiagramKind;
}

interface DiagramDto {
  courseId: string;
  kind: string;
  renderer: string;
  source: string;
}

const AI_WORKER_URL = process.env['AI_WORKER_URL'] ?? 'http://localhost:8001';

@ApiTags('diagrams')
@Controller()
export class DiagramsController {
  constructor(private readonly budget: BudgetService) {}

  @Post('diagrams/generate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate a Mermaid diagram from course materials' })
  async generate(
    @CurrentUser() user: AuthContext,
    @Body() dto: GenerateDiagramDto,
  ): Promise<DiagramDto> {
    await enforceBudget(this.budget, user.tenantId);
    const body = {
      tenant_id: user.tenantId,
      user_id: user.userId,
      course_id: isUuid(dto.courseId) ? dto.courseId : null,
      folder_id: isUuid(dto.folderId) ? dto.folderId : null,
      ...(dto.chapters && dto.chapters.length > 0 ? { chapters: dto.chapters } : {}),
      query: dto.query ?? '',
      kind: dto.kind ?? 'flowchart',
    };
    const res = await fetch(`${AI_WORKER_URL}/v1/diagrams/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new ProblemException({
        status: 502,
        code: 'diagrams.upstream-failed',
        title: 'Diagram pipeline failed',
        detail,
      });
    }
    const json = (await res.json()) as {
      course_id: string;
      kind: string;
      renderer: string;
      source: string;
    };
    return {
      courseId: json.course_id,
      kind: json.kind,
      renderer: json.renderer,
      source: json.source,
    };
  }
}
