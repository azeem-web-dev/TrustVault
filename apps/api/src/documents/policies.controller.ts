import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Actor } from '../common/request-context.js';
import { CurrentActor, Roles, StepUp } from '../auth/decorators.js';
import { DownloadApprovalsService } from './download-approvals.service.js';
import { AccessPolicyService } from './access-policy.service.js';
import { RolePolicySchema } from './policy-input.js';

const Uuid = z.uuid({ version: 'v4' });
const Note = z.string().trim().max(500).optional();
const ApproveSchema = z.strictObject({
  hours: z.number().int().min(1).max(72).default(24),
  uses: z.number().int().min(1).max(10).default(1),
  note: Note,
});
const RejectSchema = z.strictObject({ note: Note });
const RoleParam = z.enum(['OWNER', 'VIEWER', 'EXTERNAL']);

function requestId(id: string): string {
  if (!Uuid.safeParse(id).success) throw new NotFoundException('Request not found');
  return id;
}

/** Download requests waiting for a decision (THREATS.md P8-P10). */
@Controller('download-requests')
export class DownloadRequestsController {
  constructor(@Inject(DownloadApprovalsService) private readonly approvals: DownloadApprovalsService) {}

  /** Requests I may decide: documents I own, or shares where I am the nominated approver. */
  @Get()
  async inbox(@CurrentActor() actor: Actor) {
    return { requests: await this.approvals.inbox(actor) };
  }

  /** Owner or nominated approver; never the requester. */
  @Post(':rid/approve')
  @HttpCode(200)
  approve(@CurrentActor() actor: Actor, @Param('rid') rid: string, @Body(new ZodPipe(ApproveSchema)) body: z.infer<typeof ApproveSchema>) {
    return this.approvals.decide(actor, requestId(rid), true, body);
  }

  @Post(':rid/reject')
  @HttpCode(200)
  reject(@CurrentActor() actor: Actor, @Param('rid') rid: string, @Body(new ZodPipe(RejectSchema)) body: z.infer<typeof RejectSchema>) {
    return this.approvals.decide(actor, requestId(rid), false, body);
  }
}

/** Organisation-wide time window and network rules per role. ADMIN only. */
@Controller('admin/access-policies')
@Roles('ADMIN')
export class RolePoliciesController {
  constructor(@Inject(AccessPolicyService) private readonly policies: AccessPolicyService) {}

  @Get()
  async list(@CurrentActor() actor: Actor) {
    return { policies: await this.policies.listRolePolicies(actor) };
  }

  @Put(':role')
  @StepUp()
  set(@CurrentActor() actor: Actor, @Param('role', new ZodPipe(RoleParam)) role: z.infer<typeof RoleParam>, @Body(new ZodPipe(RolePolicySchema)) body: z.infer<typeof RolePolicySchema>) {
    return this.policies.setRolePolicy(actor, role, body);
  }

  @Delete(':role')
  @StepUp()
  @HttpCode(204)
  async clear(@CurrentActor() actor: Actor, @Param('role', new ZodPipe(RoleParam)) role: z.infer<typeof RoleParam>) {
    await this.policies.clearRolePolicy(actor, role);
  }
}
