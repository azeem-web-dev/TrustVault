import { Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, BadRequestException } from '@nestjs/common';
import type { Actor } from '../common/request-context.js';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentActor, StepUp } from './decorators.js';
import { SessionService } from './session.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });

/**
 * Signed-in devices (THREATS.md S23). Who may call: any fully signed-in
 * user, for their own sessions only. Every query is scoped to the caller's
 * user id, so another person's session id answers 404 exactly like a
 * made-up one. Signing other devices out needs a fresh second factor.
 */
@Controller('auth/sessions')
export class SessionsController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentActor() actor: Actor) {
    return { sessions: await this.sessions.listForUser(actor) };
  }

  /** Signs one of your other devices out. Use POST /auth/logout for this one. */
  @Delete(':id')
  @HttpCode(204)
  @StepUp()
  async revoke(@CurrentActor() actor: Actor, @Param('id', uuid) id: string): Promise<void> {
    if (id === actor.sessionId) throw new BadRequestException('To end this session, sign out');
    await this.prisma.$transaction(async (tx) => {
      const own = await tx.session.findFirst({ where: { id, userId: actor.userId, revokedAt: null }, select: { id: true } });
      if (!own) throw new NotFoundException('Session not found');
      await this.sessions.revoke(id, tx, 'signed_out_by_user');
      await this.audit.record({ action: 'auth.session_revoke', outcome: 'ALLOWED', targetType: 'session', targetId: id }, tx);
    });
  }

  /** Signs every other device out, keeping this one. */
  @Post('revoke-others')
  @HttpCode(200)
  @StepUp()
  async revokeOthers(@CurrentActor() actor: Actor) {
    const ended = await this.prisma.$transaction(async (tx) => {
      const n = await this.sessions.revokeAllForUser(actor.userId, tx, actor.sessionId, 'signed_out_by_user');
      await this.audit.record({ action: 'auth.sessions_revoke_others', outcome: 'ALLOWED', targetType: 'user', targetId: actor.userId, details: { sessionsEnded: n } }, tx);
      return n;
    });
    return { ended };
  }
}
