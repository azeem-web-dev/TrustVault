import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Actor } from '../common/request-context.js';
import { CurrentActor, Roles } from '../auth/decorators.js';
import { ApprovalsService } from './approvals.service.js';

const RequestSchema = z.strictObject({
  action: z.enum(['MFA_RESET', 'BREAK_GLASS']),
  targetUserId: z.uuid().optional(),
  documentId: z.uuid().optional(),
  reason: z.string().trim().min(20, 'Explain in at least 20 characters why this is needed').max(500),
});

const uuid = new ParseUUIDPipe({ version: '4' });

/**
 * Two-administrator approvals (THREATS.md S19). Who may call every route
 * here: ADMIN only, after a second factor. The service and the database
 * decide who may approve, reject or use each request.
 */
@Controller('admin/approvals')
@Roles('ADMIN')
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly approvals: ApprovalsService) {}

  @Get()
  async list(@CurrentActor() actor: Actor) {
    return { approvals: await this.approvals.list(actor) };
  }

  /** Ask for a second admin's approval. 409 `no_second_admin` when there is no other active admin. */
  @Post()
  async request(@CurrentActor() actor: Actor, @Body(new ZodPipe(RequestSchema)) body: z.infer<typeof RequestSchema>) {
    return { approval: await this.approvals.request(actor, body) };
  }

  /** Another active admin approves. A break-glass approval emails the document's owner at once. */
  @Post(':id/approve')
  @HttpCode(200)
  async approve(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return { approval: await this.approvals.approve(actor, id) };
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return { approval: await this.approvals.reject(actor, id) };
  }
}
