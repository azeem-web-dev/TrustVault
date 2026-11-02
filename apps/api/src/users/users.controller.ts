import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Actor } from '../common/request-context.js';
import { CurrentActor, Roles } from '../auth/decorators.js';
import { PasswordSchema } from '../auth/password.service.js';
import { UsersService } from './users.service.js';
import { PasswordResetService } from '../auth/password-reset.service.js';
import { NotifyService } from '../mail/notify.service.js';

const RoleSchema = z.enum(['ADMIN', 'OWNER', 'VIEWER', 'EXTERNAL']);
const Email = z.email().max(254);
const DisplayName = z.string().trim().min(1).max(100);

const CreateUserSchema = z.strictObject({
  email: Email,
  displayName: DisplayName,
  role: RoleSchema,
  password: PasswordSchema,
  accessExpiresAt: z.coerce.date().optional(),
});

const UpdateUserSchema = z
  .strictObject({
    displayName: DisplayName.optional(),
    role: RoleSchema.optional(),
    accessExpiresAt: z.coerce.date().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const ResetPasswordSchema = z.strictObject({ password: PasswordSchema });

const uuid = new ParseUUIDPipe({ version: '4' });

/** Who may call every route here: ADMIN only. */
@Controller('admin/users')
@Roles('ADMIN')
export class UsersController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordResetService) private readonly resets: PasswordResetService,
    @Inject(NotifyService) private readonly notify: NotifyService,
  ) {}

  @Get()
  async list() {
    return { users: await this.users.list() };
  }

  @Post()
  async create(@Body(new ZodPipe(CreateUserSchema)) body: z.infer<typeof CreateUserSchema>) {
    return { user: await this.users.create(body) };
  }

  @Patch(':id')
  async update(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body(new ZodPipe(UpdateUserSchema)) body: z.infer<typeof UpdateUserSchema>) {
    return { user: await this.users.update(actor, id, body) };
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  async deactivate(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return { user: await this.users.deactivate(actor, id) };
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  async reactivate(@Param('id', uuid) id: string) {
    return { user: await this.users.reactivate(id) };
  }

  @Post(':id/mfa/reset')
  @HttpCode(204)
  async resetMfa(@CurrentActor() actor: Actor, @Param('id', uuid) id: string): Promise<void> {
    await this.users.resetMfa(actor, id);
    this.notify.secondFactorChanged(id, 'An administrator removed your second factor. You will be asked to set one up again when you next sign in.');
  }

  @Post(':id/password')
  @HttpCode(204)
  async resetPassword(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body(new ZodPipe(ResetPasswordSchema)) body: z.infer<typeof ResetPasswordSchema>): Promise<void> {
    await this.users.resetPassword(actor, id, body.password);
    this.notify.passwordChanged(id, 'by an administrator');
  }

  /** Emails the person a reset link. The admin never sees or sets the new password (THREATS.md S15). */
  @Post(':id/reset-link')
  @HttpCode(202)
  async sendResetLink(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return { ok: true, ...(await this.resets.adminSend(actor, id)) };
  }
}
