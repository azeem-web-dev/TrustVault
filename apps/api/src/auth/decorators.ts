import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '../generated/prisma/enums.js';
import { currentContext, type Actor } from '../common/request-context.js';

export const PUBLIC_KEY = 'tv:public';
export const ROLES_KEY = 'tv:roles';

/**
 * Marks a route as reachable without a session. Everything else requires
 * one: authentication is deny-by-default, so a new route that forgets a
 * decorator is protected, not exposed.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** Restricts a route to the given account roles (checked after the session). */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

/** The authenticated caller. Only valid on routes that are not @Public(). */
export const CurrentActor = createParamDecorator((_: unknown, _ctx: ExecutionContext): Actor => {
  const actor = currentContext()?.actor;
  if (!actor) throw new Error('CurrentActor used on a route without an authenticated actor');
  return actor;
});
