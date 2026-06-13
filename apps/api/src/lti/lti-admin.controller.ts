import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../prisma/prisma.service';

class RegisterPlatformDto {
  @IsString() @MaxLength(160) name!: string;
  @IsString() @MaxLength(160) domain!: string;
  @IsString() @MaxLength(240) ltiIssuer!: string;
  @IsString() @MaxLength(160) ltiClientId!: string;
  @IsString() @MaxLength(160) ltiDeploymentId!: string;
  @IsUrl({ require_protocol: true }) ltiJwksUri!: string;
  @IsOptional() @IsString() @MaxLength(4000) samlMetadata?: string;
}

interface InstitutionRow {
  id: string;
  name: string;
  domain: string;
  ltiIssuer: string | null;
  ltiClientId: string | null;
  ltiDeploymentId: string | null;
  ltiJwksUri: string | null;
  createdAt: string;
}

/**
 * Ops surface for LTI platform registration.
 *
 * Until Phase B-4 lands a real RBAC decorator, the endpoints gate on
 * ``user.role in {admin, institution_admin}`` inline. Anyone else gets
 * a 403; we'd rather refuse early than ship a tenant takeover path.
 */
@ApiTags('lti-admin')
@Controller('admin/lti')
export class LtiAdminController {
  private readonly log = new Logger(LtiAdminController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Post('platforms')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Register an LTI 1.3 platform. Upserts on ltiIssuer so a Canvas/Moodle/Blackboard re-registration just rewrites the keyset URL.',
  })
  async registerPlatform(
    @CurrentUser() user: AuthContext,
    @Body() dto: RegisterPlatformDto,
  ): Promise<InstitutionRow> {
    requireAdmin(user);

    // Upsert on ``ltiIssuer`` (the schema's @unique index) so calling
    // this endpoint again with a new ``ltiJwksUri`` is a clean key
    // rotation rather than a 409 conflict the caller has to handle.
    try {
      const inst = await this.prisma.institution.upsert({
        where: { ltiIssuer: dto.ltiIssuer },
        create: {
          name: dto.name,
          domain: dto.domain,
          ltiIssuer: dto.ltiIssuer,
          ltiClientId: dto.ltiClientId,
          ltiDeploymentId: dto.ltiDeploymentId,
          ltiJwksUri: dto.ltiJwksUri,
          samlMetadata: dto.samlMetadata,
        },
        update: {
          name: dto.name,
          domain: dto.domain,
          ltiClientId: dto.ltiClientId,
          ltiDeploymentId: dto.ltiDeploymentId,
          ltiJwksUri: dto.ltiJwksUri,
          samlMetadata: dto.samlMetadata,
        },
      });
      this.log.log(
        `lti.platform.registered actor=${user.userId} iss=${inst.ltiIssuer} jwks=${inst.ltiJwksUri}`,
      );
      return rowOf(inst);
    } catch (err) {
      // The ``domain`` column also has a unique constraint — a caller
      // trying to register two issuers under the same domain hits that.
      // Surface as a 409 instead of a 500 so the operator knows the
      // domain is taken.
      if (isUniqueConstraintViolation(err)) {
        throw new ProblemException({
          status: 409,
          code: 'lti.platform.domain-taken',
          title: 'Another LTI platform is already registered with this domain',
        });
      }
      throw err;
    }
  }

  @Get('platforms')
  @HttpCode(200)
  @ApiOperation({
    summary: 'List registered LTI platforms (ops visibility, no secrets exposed)',
  })
  async listPlatforms(
    @CurrentUser() user: AuthContext,
  ): Promise<{ platforms: InstitutionRow[] }> {
    requireAdmin(user);
    const rows = await this.prisma.institution.findMany({
      where: { ltiIssuer: { not: null }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { platforms: rows.map(rowOf) };
  }
}

function requireAdmin(user: AuthContext): void {
  if (user.role !== 'admin' && user.role !== 'institution_admin') {
    throw new ForbiddenException(
      'LTI admin endpoints require admin or institution_admin role',
    );
  }
}

function rowOf(inst: {
  id: string;
  name: string;
  domain: string;
  ltiIssuer: string | null;
  ltiClientId: string | null;
  ltiDeploymentId: string | null;
  ltiJwksUri: string | null;
  createdAt: Date;
}): InstitutionRow {
  return {
    id: inst.id,
    name: inst.name,
    domain: inst.domain,
    ltiIssuer: inst.ltiIssuer,
    ltiClientId: inst.ltiClientId,
    ltiDeploymentId: inst.ltiDeploymentId,
    ltiJwksUri: inst.ltiJwksUri,
    createdAt: inst.createdAt.toISOString(),
  };
}

function isUniqueConstraintViolation(err: unknown): boolean {
  // Prisma error code P2002 = "Unique constraint failed."
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002'
  );
}
