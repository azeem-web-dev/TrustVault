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

export const PARTIAL_AUTH_KEY = 'tv:partial-auth';

/**
 * Reachable with a password-only session that still owes a second factor.
 * Only sign-in completion, MFA enrolment, "who am I" and sign-out use this.
 * Every other route needs the second factor when the account requires one.
 */
export const PartialAuth = (): MethodDecorator & ClassDecorator => SetMetadata(PARTIAL_AUTH_KEY, true);

/** Restricts a route to the given account roles (checked after the session). */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

/** The authenticated caller. Only valid on routes that are not @Public(). */
export const CurrentActor = createParamDecorator((_: unknown, _ctx: ExecutionContext): Actor => {
  const actor = currentContext()?.actor;
  if (!actor) throw new Error('CurrentActor used on a route without an authenticated actor');
  return actor;
});
