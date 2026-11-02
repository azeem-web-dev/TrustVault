import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
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

export const STEP_UP_KEY = 'tv:step-up';

/** Decides from the raw request whether this call is the risky kind (e.g. a role change). */
export type StepUpWhen = (req: Request) => boolean;

/**
 * A risky action: the second factor must have been presented in this
 * session within STEP_UP_MINUTES, or the guard answers 403
 * `step_up_required` and the client asks for a fresh code (THREATS.md S19).
 * `when` narrows it to some calls of the route; omitted, every call.
 * Accounts that need no second factor are not asked (they have none).
 */
export const StepUp = (when?: StepUpWhen): MethodDecorator & ClassDecorator => SetMetadata(STEP_UP_KEY, when ?? true);

/** Restricts a route to the given account roles (checked after the session). */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

/** The authenticated caller. Only valid on routes that are not @Public(). */
export const CurrentActor = createParamDecorator((_: unknown, _ctx: ExecutionContext): Actor => {
  const actor = currentContext()?.actor;
  if (!actor) throw new Error('CurrentActor used on a route without an authenticated actor');
  return actor;
});
