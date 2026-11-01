import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { ENV, type Env } from '../config/env.js';

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    // Connects as the low-privilege app role. It owns no tables, so
    // row-level security and the audit triggers always apply to it.
    super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 10 }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
