import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Actor } from '../common/request-context.js';
import { CurrentActor, Roles } from '../auth/decorators.js';
import { PrismaService } from '../db/prisma.service.js';

const QuerySchema = z.strictObject({ q: z.string().trim().min(2).max(100) });

/**
 * The people picker used when sharing. Who may call: ADMIN, OWNER, VIEWER.
 * External accounts cannot browse the company directory. Returns at most
 * 10 active accounts matching at least two typed characters, so it cannot
 * be used to dump the user list in one request.
 */
@Controller('directory')
@Roles('ADMIN', 'OWNER', 'VIEWER')
export class DirectoryController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async search(@CurrentActor() actor: Actor, @Query(new ZodPipe(QuerySchema)) query: z.infer<typeof QuerySchema>) {
    const [users, groups] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          status: 'ACTIVE',
          id: { not: actor.userId },
          OR: [{ displayName: { contains: query.q, mode: 'insensitive' } }, { email: { contains: query.q, mode: 'insensitive' } }],
        },
        select: { id: true, displayName: true, email: true, role: true, accessExpiresAt: true },
        orderBy: { displayName: 'asc' },
        take: 10,
      }),
      this.prisma.group.findMany({
        where: { name: { contains: query.q, mode: 'insensitive' } },
        select: { id: true, name: true, _count: { select: { members: true } } },
        orderBy: { name: 'asc' },
        take: 5,
      }),
    ]);
    return {
      users,
      groups: groups.map((g) => ({ id: g.id, name: g.name, members: g._count.members })),
    };
  }
}
