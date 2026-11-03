import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { ENV, type Env } from '../config/env.js';
import { currentContext } from '../common/request-context.js';
import { normalizeIp } from '../common/ip.js';

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    // Connects as the low-privilege app role. It owns no tables, so
    // row-level security and the audit triggers always apply to it.
    // Password hashes and TOTP secrets are not readable by that role
    // (THREATS.md A26): never select them; read one through its function.
    super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 10 }), omit: { user: { passwordHash: true, totpSecretEnc: true } } });
  }

  /**
   * Runs `fn` in a transaction where the database knows who is asking.
   * set_config(..., true) scopes app.user_id to this transaction only, so it
   * can never leak to the next request that reuses the pooled connection.
   * Every query on a document table must go through here; outside it,
   * row-level security sees no user and returns no rows.
   *
   * app.client_ip carries the client address (as Express derived it, trusting
   * X-Forwarded-For only from the configured proxy) for the network rules of
   * access policies. Unknown means no allowlist matches (THREATS.md P5).
   */
  async asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(userId)) throw new Error('asUser: invalid user id');
    return this.$transaction(
      async (tx) => {
        const ip = normalizeIp(currentContext()?.ip) ?? '';
        await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true), set_config('app.client_ip', ${ip}, true)`;
        return fn(tx);
      },
      { maxWait: 5_000, timeout: 30_000 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
