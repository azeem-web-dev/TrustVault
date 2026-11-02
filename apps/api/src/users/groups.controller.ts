import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { Roles } from '../auth/decorators.js';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

const Uuid = z.uuid({ version: 'v4' });
const GroupSchema = z.strictObject({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).optional() });
const UpdateSchema = z.strictObject({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(300).nullable().optional() });
const MemberSchema = z.strictObject({ userId: Uuid });

const id = (v: string): string => {
  if (!Uuid.safeParse(v).success) throw new NotFoundException('Not found');
  return v;
};

/**
 * Groups make sharing with a team one grant instead of twenty. Membership is
 * read live on every request, so removing someone from a group removes
 * their access through it immediately. Who may call: ADMIN only.
 */
@Controller('admin/groups')
@Roles('ADMIN')
export class GroupsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    const groups = await this.prisma.group.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, description: true, createdAt: true,
        members: { select: { addedAt: true, user: { select: { id: true, displayName: true, email: true, role: true, status: true } } }, orderBy: { addedAt: 'asc' } },
        _count: { select: { grants: true } },
      },
    });
    return {
      groups: groups.map((g) => ({
        id: g.id, name: g.name, description: g.description, createdAt: g.createdAt, documentGrants: g._count.grants,
        members: g.members.map((m) => ({ ...m.user, addedAt: m.addedAt })),
      })),
    };
  }

  @Post()
  async create(@Body(new ZodPipe(GroupSchema)) body: z.infer<typeof GroupSchema>) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const g = await tx.group.create({ data: { name: body.name, description: body.description ?? null }, select: { id: true, name: true } });
        await this.audit.record({ action: 'group.create', outcome: 'ALLOWED', targetType: 'group', targetId: g.id, details: { name: g.name } }, tx);
        return g;
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ConflictException('A group with that name already exists');
      throw err;
    }
  }

  @Patch(':id')
  async update(@Param('id') groupId: string, @Body(new ZodPipe(UpdateSchema)) body: z.infer<typeof UpdateSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.group.updateMany({ where: { id: id(groupId) }, data: { name: body.name, description: body.description } });
      if (r.count === 0) throw new NotFoundException('Group not found');
      await this.audit.record({ action: 'group.update', outcome: 'ALLOWED', targetType: 'group', targetId: groupId, details: body }, tx);
      return { id: groupId };
    });
  }

  /** Deleting a group removes every document grant made to it, in the same transaction. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') groupId: string) {
    await this.prisma.$transaction(async (tx) => {
      const g = await tx.group.findUnique({ where: { id: id(groupId) }, select: { name: true, _count: { select: { grants: true, members: true } } } });
      if (!g) throw new NotFoundException('Group not found');
      // Every member's and every shared document's lock, in order, before the
      // cascade: no download through this group is half-way (THREATS.md R11).
      await tx.$executeRaw`SELECT tv_lock_group(${groupId}::uuid)`;
      await tx.group.delete({ where: { id: groupId } });
      await this.audit.record({ action: 'group.delete', outcome: 'ALLOWED', targetType: 'group', targetId: groupId, details: { name: g.name, grantsRemoved: g._count.grants, members: g._count.members } }, tx);
    });
  }

  @Post(':id/members')
  @HttpCode(204)
  async addMember(@Param('id') groupId: string, @Body(new ZodPipe(MemberSchema)) body: z.infer<typeof MemberSchema>) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT tv_lock_user(${body.userId}::uuid, true)`;
      const user = await tx.user.findUnique({ where: { id: body.userId }, select: { role: true, status: true, email: true } });
      if (!user || user.status !== 'ACTIVE') throw new BadRequestException('User not found or inactive');
      if (user.role === 'EXTERNAL') throw new BadRequestException('External people cannot be added to groups');
      if (user.role === 'ADMIN') throw new BadRequestException('Administrators cannot join groups: they never get document access');
      const group = await tx.group.findUnique({ where: { id: id(groupId) }, select: { name: true } });
      if (!group) throw new NotFoundException('Group not found');
      await tx.groupMember.upsert({ where: { groupId_userId: { groupId, userId: body.userId } }, create: { groupId, userId: body.userId }, update: {} });
      await this.audit.record({ action: 'group.member_add', outcome: 'ALLOWED', targetType: 'group', targetId: groupId, details: { group: group.name, userId: body.userId, email: user.email } }, tx);
    });
  }

  /** Takes effect on the member's next request: group membership is never cached. */
  @Delete(':id/members/:userId')
  @HttpCode(204)
  async removeMember(@Param('id') groupId: string, @Param('userId') userId: string) {
    await this.prisma.$transaction(async (tx) => {
      // The member's lock: none of their requests is mid-decision (R11).
      await tx.$executeRaw`SELECT tv_lock_user(${id(userId)}::uuid, true)`;
      const r = await tx.groupMember.deleteMany({ where: { groupId: id(groupId), userId: id(userId) } });
      if (r.count === 0) throw new NotFoundException('Member not found');
      await this.audit.record({ action: 'group.member_remove', outcome: 'ALLOWED', targetType: 'group', targetId: groupId, details: { userId } }, tx);
    });
  }
}
