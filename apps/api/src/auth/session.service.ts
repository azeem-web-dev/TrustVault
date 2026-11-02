import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import type { Actor } from '../common/request-context.js';
import { AuditService } from '../audit/audit.service.js';

export const SESSION_COOKIE = '__Host-tv_session';

const sha256 = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(createHash('sha256').update(value).digest());

/** Only write last_seen_at at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60_000;

export interface NewSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

/**
 * Server-side sessions. The browser holds a random 256-bit token in an
 * HttpOnly cookie; the database holds only its SHA-256. Every request looks
 * the session up again and re-checks the user, so deactivating a user,
 * changing their role or password, or deleting the session row takes effect
 * on the very next request. There is no JWT that stays valid until expiry.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(
    userId: string,
    meta: { ip: string | null; userAgent: string | null; authLevel?: string },
    tx?: Tx,
  ): Promise<NewSession> {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.env.SESSION_ABSOLUTE_MINUTES * 60_000);
    await (tx ?? this.prisma).session.create({
      data: {
        userId,
        tokenHash: sha256(token),
        csrfToken,
        authLevel: meta.authLevel ?? 'password',
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
    return { token, csrfToken, expiresAt };
  }

  /**
   * Resolve a cookie value to an actor, or null. Expired, idle, or orphaned
   * sessions are deleted on sight.
   */
  async resolve(token: string | undefined): Promise<Actor | null> {
    if (!token || token.length > 128) return null;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { _count: { select: { passkeys: true } } } } },
    });
    if (!session) return null;

    const now = Date.now();
    const user = session.user;
    const idleLimit = session.lastSeenAt.getTime() + this.env.SESSION_IDLE_MINUTES * 60_000;
    const invalid =
      session.revokedAt !== null ? (session.revokedReason ?? 'revoked')
      : session.expiresAt.getTime() <= now ? 'session_expired'
      : idleLimit <= now ? 'session_idle'
      : user.status !== 'ACTIVE' ? 'user_inactive'
      : user.accessExpiresAt !== null && user.accessExpiresAt.getTime() <= now ? 'user_access_expired'
      // A password change invalidates every session created before it.
      : session.createdAt.getTime() < user.passwordChangedAt.getTime() ? 'password_changed'
      : null;
    if (invalid) {
      // A cut-off person trying again is exactly what the record must show
      // (THREATS.md L10). The row is kept (marked) until it expires, so the
      // cookie stays dead and identifiable; only the first refusal is
      // recorded, so a retry loop adds one audit row, not thousands. Marking
      // and recording happen in one transaction: no mark without a record.
      await this.prisma.$transaction(async (tx) => {
        const marked = await tx.session.updateMany({
          where: { id: session.id, rejectedAt: null },
          data: { rejectedAt: new Date(now), revokedAt: session.revokedAt ?? new Date(now), revokedReason: session.revokedReason ?? invalid },
        });
        if (marked.count > 0) {
          await this.audit.record({ action: 'auth.session_rejected', outcome: 'DENIED', reason: invalid, actorId: user.id, actorEmail: user.email, targetType: 'session', targetId: session.id }, tx);
        }
      });
      return null;
    }

    if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.updateMany({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } });
    }

    const mfaEnrolled = user.totpEnabledAt !== null || user._count.passkeys > 0;
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      sessionId: session.id,
      authLevel: session.authLevel,
      csrfToken: session.csrfToken,
      mfaEnrolled,
      mfaRequired: user.role === 'ADMIN' || mfaEnrolled,
    };
  }

  /** Ends one session. Returns 1 if it was live, 0 if it had already ended. */
  async revoke(sessionId: string, tx?: Tx, reason = 'ended'): Promise<number> {
    const r = await (tx ?? this.prisma).session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    return r.count;
  }

  /** Ends every session of a user (optionally keeping one). Returns how many. */
  async revokeAllForUser(userId: string, tx?: Tx, keepSessionId?: string, reason = 'ended'): Promise<number> {
    const result = await (tx ?? this.prisma).session.updateMany({
      where: { userId, revokedAt: null, ...(keepSessionId ? { NOT: { id: keepSessionId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  static csrfMatches(expected: string, presented: string | undefined): boolean {
    if (!presented) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(presented);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
