import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { enforceBudget } from '../budget/budget-guard';
import { BudgetService } from '../budget/budget.service';
import { ProblemException } from '../common/problem';
import { isUuid } from '../common/uuid';
import { SharedFoldersService } from '../shared-folders/shared-folders.service';

class GeneratePresentationDto {
  @IsOptional() @IsString() courseId?: string;
  @IsOptional() @IsString() folderId?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) chapters?: number[];
  @IsOptional() @IsString() @MaxLength(400) query?: string;
  @IsOptional() @IsInt() @Min(4) @Max(20) slideCount?: number;
}

interface PresentationDto {
  courseId: string;
  title: string;
  markdown: string;
  slideCount: number;
}

const AI_WORKER_URL = process.env['AI_WORKER_URL'] ?? 'http://localhost:8001';

@ApiTags('presentations')
@Controller()
export class PresentationsController {
  constructor(
    private readonly budget: BudgetService,
    private readonly shared: SharedFoldersService,
  ) {}

  @Post('presentations/generate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate a markdown presentation deck from materials' })
  async generate(
    @CurrentUser() user: AuthContext,
    @Body() dto: GeneratePresentationDto,
  ): Promise<PresentationDto> {
    await enforceBudget(this.budget, user.tenantId);
    const allowedFolderIds = await this.shared.accessibleFolderIds(user.userId);
    const body = {
      tenant_id: user.tenantId,
      user_id: user.userId,
      course_id: isUuid(dto.courseId) ? dto.courseId : null,
      folder_id: isUuid(dto.folderId) ? dto.folderId : null,
      ...(dto.chapters && dto.chapters.length > 0 ? { chapters: dto.chapters } : {}),
      ...(allowedFolderIds.length > 0 ? { allowed_folder_ids: allowedFolderIds } : {}),
      query: dto.query ?? '',
      slide_count: dto.slideCount ?? 8,
    };
    const res = await fetch(`${AI_WORKER_URL}/v1/presentations/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new ProblemException({
        status: 502,
        code: 'presentations.upstream-failed',
        title: 'Presentation pipeline failed',
        detail,
      });
    }
    const json = (await res.json()) as {
      course_id: string;
      title: string;
      markdown: string;
      slide_count: number;
    };
    return {
      courseId: json.course_id,
      title: json.title,
      markdown: json.markdown,
      slideCount: json.slide_count,
    };
  }
}
