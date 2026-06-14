import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { observabilityStatus } from '../observability';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  liveness() {
    return { status: 'ok', service: 'api', ts: new Date().toISOString() };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (deps reachable)' })
  readiness() {
    return { status: 'ok', service: 'api', ts: new Date().toISOString() };
  }

  @Get('observability')
  @ApiOperation({
    summary: 'Observability wiring snapshot',
    description:
      'Confirms whether the error-monitoring safety net actually initialized. ' +
      'A silent-disabled Sentry (DSN unset) is the failure mode this surfaces. ' +
      'Probe after every deploy or include in the prod-smoke spec.',
  })
  observability() {
    return {
      ...observabilityStatus(),
      ts: new Date().toISOString(),
    };
  }
}
