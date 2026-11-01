// Creates one demo account per role. Safe to re-run: existing accounts are
// left alone (passwords are not reset).
//
// Passwords come from SEED_PASSWORD_ADMIN / _OWNER / _VIEWER / _EXTERNAL.
// In development they fall back to obvious dev-only values; in production
// the script refuses to run without them.
import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type { Role } from '../src/generated/prisma/enums.js';
import { PasswordService } from '../src/auth/password.service.js';

const isProd = process.env.NODE_ENV === 'production';

function password(role: string): string {
  const value = process.env[`SEED_PASSWORD_${role}`];
  if (value) return value;
  if (isProd) throw new Error(`SEED_PASSWORD_${role} is required in production`);
  return `dev-only-${role.toLowerCase()}-password`;
}

const DAY = 24 * 60 * 60 * 1000;

const accounts: { email: string; displayName: string; role: Role; passwordKey: string; accessExpiresAt?: Date }[] = [
  { email: 'admin@trustvault.demo', displayName: 'Ada Admin', role: 'ADMIN', passwordKey: 'ADMIN' },
  { email: 'olivia.owner@trustvault.demo', displayName: 'Olivia Owner', role: 'OWNER', passwordKey: 'OWNER' },
  { email: 'oscar.owner@trustvault.demo', displayName: 'Oscar Owner', role: 'OWNER', passwordKey: 'OWNER' },
  { email: 'victor.viewer@trustvault.demo', displayName: 'Victor Viewer', role: 'VIEWER', passwordKey: 'VIEWER' },
  { email: 'erin.external@partner.demo', displayName: 'Erin External', role: 'EXTERNAL', passwordKey: 'EXTERNAL', accessExpiresAt: new Date(Date.now() + 180 * DAY) },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const passwords = new PasswordService();
  try {
    for (const a of accounts) {
      const existing = await prisma.user.findUnique({ where: { email: a.email } });
      if (existing) {
        console.log(`exists   ${a.role.padEnd(8)} ${a.email}`);
        continue;
      }
      const user = await prisma.user.create({
        data: {
          email: a.email, displayName: a.displayName, role: a.role,
          passwordHash: await passwords.hash(password(a.passwordKey)),
          accessExpiresAt: a.accessExpiresAt ?? null,
        },
      });
      await prisma.auditEvent.create({
        data: { action: 'user.create', outcome: 'ALLOWED', reason: 'seed', targetType: 'user', targetId: user.id, details: { email: a.email, role: a.role } },
      });
      console.log(`created  ${a.role.padEnd(8)} ${a.email}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();
