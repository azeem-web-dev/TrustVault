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
import { AuditService } from '../audit/audit.service.js';
import { currentContext } from '../common/request-context.js';
import { PUBLIC_KEY, ROLES_KEY } from './decorators.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Runs before every route, in this order:
 *  1. Origin check on state-changing requests (cross-site requests refused).
 *  2. Session: required unless the route is @Public().
 *  3. CSRF token: required on state-changing requests with a session.
 *  4. Account role, if the route declares @Roles().
 * Document-level permissions are a separate, later check (decide()).
 */
@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

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
        throw new ForbiddenException('Cross-origin request refused');
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
      await this.audit.record({ action: 'security.csrf', outcome: 'DENIED', reason: 'csrf_token_mismatch', details: { method: req.method, path: req.path } });
      throw new ForbiddenException('Missing or invalid CSRF token');
    }

    // 4. Role.
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(actor.role)) {
      await this.audit.record({ action: 'security.role', outcome: 'DENIED', reason: 'role_not_allowed', details: { method: req.method, path: req.path, required: roles } });
      throw new ForbiddenException('Not allowed');
    }
    return true;
  }
}
