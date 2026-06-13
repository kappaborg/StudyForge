import { SetMetadata } from '@nestjs/common';
import type { UserRole } from './auth.context';

/**
 * Route-level role gate.
 *
 *   @Roles('admin', 'institution_admin')
 *   @Post('platforms')
 *   register(@CurrentUser() user, @Body() dto) { … }
 *
 * The actual check lives in ``RolesGuard``; this decorator only
 * stamps the allowed-role list onto the route handler's metadata.
 * When the metadata is absent every authenticated caller passes (the
 * guard short-circuits), so the decorator is opt-in per endpoint.
 */
export const ROLES_KEY = 'studyforge.roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
