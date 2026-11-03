import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Actor } from '../common/request-context.js';
import { CurrentActor, Roles, StepUp } from '../auth/decorators.js';
import { UsersService } from './users.service.js';
import { PasswordResetService } from '../auth/password-reset.service.js';
import { InviteService } from '../auth/invite.service.js';
import { NotifyService } from '../mail/notify.service.js';

const RoleSchema = z.enum(['ADMIN', 'OWNER', 'VIEWER', 'EXTERNAL']);
const Email = z.email().max(254);
const DisplayName = z.string().trim().min(1).max(100);

// No password and no name: the person chooses both from their invitation (THREATS.md S18).
const CreateUserSchema = z.strictObject({
  email: Email,
  role: RoleSchema,
  accessExpiresAt: z.coerce.date().optional(),
});

const UpdateUserSchema = z
  .strictObject({
    displayName: DisplayName.optional(),
    role: RoleSchema.optional(),
    accessExpiresAt: z.coerce.date().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

// An owner's or admin's second factor: the approval to use (THREATS.md S19).
const ResetMfaSchema = z.strictObject({ approvalId: z.uuid().optional() });

const uuid = new ParseUUIDPipe({ version: '4' });

/** Who may call every route here: ADMIN only. */
@Controller('admin/users')
@Roles('ADMIN')
export class UsersController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordResetService) private readonly resets: PasswordResetService,
    @Inject(NotifyService) private readonly notify: NotifyService,
    @Inject(InviteService) private readonly invites: InviteService,
  ) {}

  @Get()
  async list() {
    return { users: await this.users.list() };
  }

  /** Creates an INVITED account and emails the invitation. `invited` is false when mail is off. */
  @Post()
  @StepUp()
  async create(@CurrentActor() actor: Actor, @Body(new ZodPipe(CreateUserSchema)) body: z.infer<typeof CreateUserSchema>) {
    const user = await this.users.create(actor, body);
    const { sent } = await this.invites.send(actor, user.id, false);
    return { user, invited: sent };
  }

  /** Emails the invitation again; earlier links stop working. Only for INVITED accounts. */
  @Post(':id/invite')
  @HttpCode(202)
  @StepUp()
  async resendInvite(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return { ok: true, ...(await this.invites.send(actor, id, true)) };
  }

  /** A role change needs a fresh second factor (THREATS.md S20); other edits do not. */
  @Patch(':id')
  @StepUp((req) => typeof req.body === 'object' && req.body !== null && 'role' in req.body)
  async update(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body(new ZodPipe(UpdateUserSchema)) body: z.infer<typeof UpdateUserSchema>) {
    return { user: await this.users.update(actor, id, body) };
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @StepUp()
  async deactivate(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return { user: await this.users.deactivate(actor, id) };
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  async reactivate(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return { user: await this.users.reactivate(actor, id) };
  }

  /** VIEWER or EXTERNAL: one admin. OWNER or ADMIN: `{approvalId}` from a second admin (THREATS.md S19). */
  @Post(':id/mfa/reset')
  @HttpCode(204)
  @StepUp()
  async resetMfa(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body(new ZodPipe(ResetMfaSchema)) body: z.infer<typeof ResetMfaSchema>): Promise<void> {
    await this.users.resetMfa(actor, id, body.approvalId);
    this.notify.secondFactorChanged(id, 'An administrator removed your second factor. You will be asked to set one up again when you next sign in.');
  }

  /** Emails the person a reset link. The admin never sees or sets the new password (THREATS.md S15). */
  @Post(':id/reset-link')
  @HttpCode(202)
  @StepUp()
  async sendResetLink(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return { ok: true, ...(await this.resets.adminSend(actor, id)) };
  }
}
