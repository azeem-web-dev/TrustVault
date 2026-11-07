// Puts the shared public demo back to the seed (src/cli/demo-reset.ts).
// Run by infra/server/demo-reset.sh on a systemd timer; see docs/DEMO.md.
//
// As the schema owner (DATABASE_OWNER_URL), like the seed and migrations.
// Refuses to run unless DEMO_MODE=true, so it can never touch a real
// instance by accident.
import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { UTC_SESSION } from '../src/db/prisma.service.js';
import { resetDemo } from '../src/cli/demo-reset.js';

if (process.env.DEMO_MODE !== 'true') throw new Error('demo-reset: DEMO_MODE is not true; refusing to reset anything');
const owner = process.env.DATABASE_OWNER_URL;
if (!owner) throw new Error('demo-reset: DATABASE_OWNER_URL is required');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: owner, options: UTC_SESSION }) });
try {
  const summary = await resetDemo(prisma);
  console.log(`demo reset: ${JSON.stringify(summary)}`);
  if (summary.missing.length) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
