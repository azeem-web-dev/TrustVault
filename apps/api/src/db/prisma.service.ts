import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { ENV, type Env } from '../config/env.js';

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    // Connects as the low-privilege app role. It owns no tables, so
    // row-level security and the audit triggers always apply to it.
    super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 10 }) });
  }

  /**
   * Runs `fn` in a transaction where the database knows who is asking.
   * set_config(..., true) scopes app.user_id to this transaction only, so it
   * can never leak to the next request that reuses the pooled connection.
   * Every query on a document table must go through here; outside it,
   * row-level security sees no user and returns no rows.
   */
  async asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(userId)) throw new Error('asUser: invalid user id');
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
        return fn(tx);
      },
      { maxWait: 5_000, timeout: 30_000 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
