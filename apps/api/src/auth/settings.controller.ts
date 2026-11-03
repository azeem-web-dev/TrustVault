import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Actor } from '../common/request-context.js';
import { CurrentActor, Roles, StepUp } from './decorators.js';
import { MfaPolicyService } from './mfa-policy.service.js';

const PolicySchema = z.strictObject({
  requiredRoles: z.array(z.enum(['ADMIN', 'OWNER', 'VIEWER', 'EXTERNAL'])).max(4),
});

/**
 * Instance settings. Who may call: ADMIN only. Changing the second-factor
 * policy needs a fresh second factor and is audited with from/to
 * (THREATS.md S21).
 */
@Controller('admin/settings')
@Roles('ADMIN')
export class SettingsController {
  constructor(@Inject(MfaPolicyService) private readonly policy: MfaPolicyService) {}

  @Get('mfa-policy')
  async get() {
    return { requiredRoles: await this.policy.requiredRoles() };
  }

  @Put('mfa-policy')
  @StepUp()
  async put(@CurrentActor() actor: Actor, @Body(new ZodPipe(PolicySchema)) body: z.infer<typeof PolicySchema>) {
    return { requiredRoles: await this.policy.update(actor, body.requiredRoles) };
  }
}
