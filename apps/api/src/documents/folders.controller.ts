import { Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Actor } from '../common/request-context.js';
import { CurrentActor, Roles } from '../auth/decorators.js';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

const NameSchema = z.strictObject({ name: z.string().trim().min(1).max(100) });
const Uuid = z.uuid({ version: 'v4' });

/**
 * Folders organise one owner's documents and never grant access to anyone.
 * Who may call: OWNER role, on their own folders only (also enforced by the
 * folders_owner row-level security policy).
 */
@Controller('folders')
@Roles('OWNER')
export class FoldersController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentActor() actor: Actor) {
    const folders = await this.prisma.asUser(actor.userId, (tx) =>
      tx.folder.findMany({ where: { ownerId: actor.userId }, orderBy: { name: 'asc' }, select: { id: true, name: true, _count: { select: { documents: { where: { deletedAt: null } } } } } }),
    );
    return { folders: folders.map((f) => ({ id: f.id, name: f.name, documents: f._count.documents })) };
  }

  @Post()
  async create(@CurrentActor() actor: Actor, @Body(new ZodPipe(NameSchema)) body: z.infer<typeof NameSchema>) {
    try {
      return await this.prisma.asUser(actor.userId, async (tx) => {
        const f = await tx.folder.create({ data: { ownerId: actor.userId, name: body.name }, select: { id: true, name: true } });
        await this.audit.record({ action: 'folder.create', outcome: 'ALLOWED', targetType: 'folder', targetId: f.id, details: { name: f.name } }, tx);
        return f;
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ConflictException('You already have a folder with that name');
      throw err;
    }
  }

  @Patch(':id')
  async rename(@CurrentActor() actor: Actor, @Param('id') id: string, @Body(new ZodPipe(NameSchema)) body: z.infer<typeof NameSchema>) {
    if (!Uuid.safeParse(id).success) throw new NotFoundException('Folder not found');
    return this.prisma.asUser(actor.userId, async (tx) => {
      const r = await tx.folder.updateMany({ where: { id, ownerId: actor.userId }, data: { name: body.name } });
      if (r.count === 0) throw new NotFoundException('Folder not found');
      await this.audit.record({ action: 'folder.rename', outcome: 'ALLOWED', targetType: 'folder', targetId: id, details: { name: body.name } }, tx);
      return { id, name: body.name };
    });
  }

  /** Deleting a folder never deletes documents; they move out of it. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentActor() actor: Actor, @Param('id') id: string) {
    if (!Uuid.safeParse(id).success) throw new NotFoundException('Folder not found');
    await this.prisma.asUser(actor.userId, async (tx) => {
      const r = await tx.folder.deleteMany({ where: { id, ownerId: actor.userId } });
      if (r.count === 0) throw new NotFoundException('Folder not found');
      await this.audit.record({ action: 'folder.delete', outcome: 'ALLOWED', targetType: 'folder', targetId: id }, tx);
    });
  }
}
