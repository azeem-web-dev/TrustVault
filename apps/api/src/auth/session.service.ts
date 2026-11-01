import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import type { Actor } from '../common/request-context.js';

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
      session.expiresAt.getTime() <= now ||
      idleLimit <= now ||
      user.status !== 'ACTIVE' ||
      (user.accessExpiresAt !== null && user.accessExpiresAt.getTime() <= now) ||
      // A password change invalidates every session created before it.
      session.createdAt.getTime() < user.passwordChangedAt.getTime();
    if (invalid) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
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

  async revoke(sessionId: string, tx?: Tx): Promise<void> {
    await (tx ?? this.prisma).session.deleteMany({ where: { id: sessionId } });
  }

  /** Ends every session of a user (optionally keeping one). Returns how many. */
  async revokeAllForUser(userId: string, tx?: Tx, keepSessionId?: string): Promise<number> {
    const result = await (tx ?? this.prisma).session.deleteMany({
      where: { userId, ...(keepSessionId ? { NOT: { id: keepSessionId } } : {}) },
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
