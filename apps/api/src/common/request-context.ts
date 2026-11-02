import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../generated/prisma/enums.js';

/** The authenticated caller, as established by the session guard. */
export interface Actor {
  userId: string;
  email: string;
  role: Role;
  sessionId: string;
  /** "password", or "mfa" once a second factor was presented in this session. */
  authLevel: string;
  csrfToken: string;
  /** Has a TOTP app or passkey registered. */
  mfaEnrolled: boolean;
  /** Must present a second factor before using the app (every ADMIN, and anyone enrolled). */
  mfaRequired: boolean;
}

/** Per-request facts the audit log needs, available anywhere in the call. */
export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  actor: Actor | null;
  /**
   * Set once a refusal for this request has been written to the audit log
   * (by the security guard), so the global error filter does not record the
   * same refusal a second time.
   */
  refusalAudited?: boolean;
  /** The raw document id a route rejected as malformed (see docId()). */
  rejectedDocumentId?: string;
}

/** Marks the current request's refusal as already audited. */
export function markRefusalAudited(): void {
  const ctx = storage.getStore();
  if (ctx) ctx.refusalAudited = true;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ctx: RequestContext = {
    requestId: randomUUID(),
    // req.ip honours X-Forwarded-For only from the trusted proxy (loopback);
    // see `trust proxy` in main.ts.
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
    actor: null,
  };
  res.setHeader('X-Request-Id', ctx.requestId);
  storage.run(ctx, () => next());
}
