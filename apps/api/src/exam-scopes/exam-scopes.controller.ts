import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { ExamScopesService } from './exam-scopes.service';

class ScopeEntryDto {
  @IsIn(['theory', 'problems'])
  mode!: 'theory' | 'problems';

  @IsArray()
  @ArrayMaxSize(64)
  @IsInt({ each: true })
  chapters!: number[];

  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  topics!: string[];
}

class CreateExamScopeDto {
  @IsString()
  folderId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ScopeEntryDto)
  scopes!: ScopeEntryDto[];

  @IsOptional()
  @IsDateString()
  examDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  rawText?: string;
}

class UpdateExamScopeDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ScopeEntryDto)
  scopes?: ScopeEntryDto[];

  @IsOptional()
  @IsDateString()
  examDate?: string | null;
}

class ParseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  text!: string;
}

@ApiTags('exam-scopes')
@Controller('exam-scopes')
export class ExamScopesController {
  constructor(private readonly service: ExamScopesService) {}

  @Get()
  @ApiOperation({ summary: "List the current user's exam scopes" })
  async list(@CurrentUser() user: AuthContext) {
    return { scopes: await this.service.list(user.tenantId, user.userId) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single exam scope by id' })
  async get(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.get(user.tenantId, user.userId, id);
  }

  @Post('parse')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Parse free-text exam scope (e.g. a copy-paste from the professor) into structured form. Student confirms before saving.',
  })
  async parse(@Body() dto: ParseDto) {
    return this.service.parse(dto.text);
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Create a new exam scope' })
  async create(
    @CurrentUser() user: AuthContext,
    @Body() dto: CreateExamScopeDto,
  ) {
    return this.service.create(user.tenantId, user.userId, dto);
  }

  @Patch(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update an exam scope' })
  async update(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateExamScopeDto,
  ) {
    return this.service.update(user.tenantId, user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete an exam scope' })
  async remove(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.service.remove(user.tenantId, user.userId, id);
  }
}
