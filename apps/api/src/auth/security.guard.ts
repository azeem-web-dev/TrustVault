import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ENV, type Env } from '../config/env.js';
import type { Role } from '../generated/prisma/enums.js';
import { AuditService, type AuditInput } from '../audit/audit.service.js';
import { logger } from '../common/logger.js';
import { currentContext, markRefusalAudited } from '../common/request-context.js';
import { ErrorsFilter } from '../common/errors.filter.js';
import { PrismaService } from '../db/prisma.service.js';
import { PARTIAL_AUTH_KEY, PUBLIC_KEY, ROLES_KEY, STEP_UP_KEY, type StepUpWhen } from './decorators.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Runs before every route, in this order:
 *  1. Origin check on state-changing requests (cross-site requests refused).
 *  2. Session: required unless the route is @Public().
 *  3. CSRF token: required on state-changing requests with a session.
 *  4. Second factor, if the account requires one.
 *  5. Account role, if the route declares @Roles().
 *  6. A recent second factor, if the route declares @StepUp().
 * Document-level permissions are a separate, later check (decide()).
 */
@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) prisma: PrismaService,
  ) {
    // The global error filter is created with `new` in bootstrap.ts, outside
    // the DI container; hand it the audit service so it can record refusals
    // that happen before a route's own authorisation check.
    ErrorsFilter.useAudit(audit, prisma);
  }

  /**
   * Records a refusal, then throws it. A failure to record is logged and
   * never turns the refusal into a success: the original error is thrown.
   */
  private async refuse(input: AuditInput, refusal: Error): Promise<never> {
    try {
      await this.audit.record(input);
      markRefusalAudited();
    } catch (err) {
      logger.error({ err, action: input.action, requestId: currentContext()?.requestId }, 'failed to audit a refusal');
    }
    throw refusal;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets) === true;
    const mutating = !SAFE_METHODS.has(req.method);

    // 1. Browsers always send Origin on cross-site POST/PUT/PATCH/DELETE.
    //    Requests without Origin are not from a browser page, so they are not
    //    a CSRF vector; they still need a valid session and CSRF token below.
    if (mutating) {
      const origin = req.get('origin');
      if (origin !== undefined && origin !== this.env.PUBLIC_ORIGIN) {
        // No session is resolved yet (resolving would touch lastSeenAt on
        // behalf of a cross-site request), so the actor is unknown here.
        await this.refuse(
          { action: 'security.origin_refused', outcome: 'DENIED', reason: 'cross_origin', details: { method: req.method, path: req.path, origin: origin.slice(0, 256) } },
          new ForbiddenException('Cross-origin request refused'),
        );
      }
    }

    if (isPublic) return true;

    // 2. Session.
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const actor = await this.sessions.resolve(token);
    if (!actor) throw new UnauthorizedException('Sign in required');
    const ctx = currentContext();
    if (ctx) ctx.actor = actor;

    // 3. CSRF.
    if (mutating && !SessionService.csrfMatches(actor.csrfToken, req.get('x-csrf-token'))) {
      await this.refuse(
        { action: 'security.csrf', outcome: 'DENIED', reason: 'csrf_token_mismatch', details: { method: req.method, path: req.path } },
        new ForbiddenException('Missing or invalid CSRF token'),
      );
    }

    // 4. Second factor. A session that owes one can only reach the routes
    //    that complete sign-in (@PartialAuth). Applies to every ADMIN and to
    //    anyone who has enrolled a TOTP app or passkey.
    const partialOk = this.reflector.getAllAndOverride<boolean>(PARTIAL_AUTH_KEY, targets) === true;
    if (actor.mfaRequired && actor.authLevel !== 'mfa' && !partialOk) {
      const code = actor.mfaEnrolled ? 'mfa_required' : 'mfa_enrolment_required';
      await this.refuse(
        { action: 'security.mfa_required', outcome: 'DENIED', reason: code, actorId: actor.userId, actorEmail: actor.email, details: { method: req.method, path: req.path } },
        new ForbiddenException({ message: 'Second factor required', code }),
      );
    }

    // 5. Role.
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(actor.role)) {
      await this.refuse(
        { action: 'security.role', outcome: 'DENIED', reason: 'role_not_allowed', details: { method: req.method, path: req.path, required: roles } },
        new ForbiddenException('Not allowed'),
      );
    }

    // 6. Step-up. Risky actions need a second factor presented within
    //    STEP_UP_MINUTES in this session (THREATS.md S20). After the role
    //    check, so a caller who may not use the route at all is told that.
    const stepUp = this.reflector.getAllAndOverride<StepUpWhen | true | undefined>(STEP_UP_KEY, targets);
    if (stepUp && actor.mfaRequired && (stepUp === true || stepUp(req))) {
      const verifiedAt = actor.mfaVerifiedAt?.getTime() ?? 0;
      if (Date.now() - verifiedAt > this.env.STEP_UP_MINUTES * 60_000) {
        await this.refuse(
          { action: 'security.step_up_required', outcome: 'DENIED', reason: actor.mfaVerifiedAt ? 'second_factor_stale' : 'no_second_factor_in_session', details: { method: req.method, path: req.path } },
          new ForbiddenException({ message: 'Confirm it’s you: enter a code from your authenticator app or use your passkey', code: 'step_up_required' }),
        );
      }
    }
    return true;
  }
}
