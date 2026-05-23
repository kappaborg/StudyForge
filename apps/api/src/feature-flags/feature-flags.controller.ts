import { Body, Controller, Get, HttpCode, Param, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { FeatureFlagsService, type FeatureFlagDto } from './feature-flags.service';

class ToggleDto {
  @IsBoolean()
  enabled!: boolean;
}

@ApiTags('feature-flags')
@Controller('feature-flags')
export class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsService) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'List all feature flags' })
  list(): Promise<FeatureFlagDto[]> {
    return this.flags.list();
  }

  @Patch(':name')
  @HttpCode(200)
  @ApiOperation({ summary: 'Toggle a feature flag (instructor-only in prod)' })
  set(@Param('name') name: string, @Body() dto: ToggleDto): Promise<FeatureFlagDto> {
    return this.flags.setEnabled(name, dto.enabled);
  }
}
