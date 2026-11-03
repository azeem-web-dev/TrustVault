import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { localTicketKey } from '../src/crypto/key-provider.js';

// Bring the test database up to the latest migration before any test runs.
// `migrate deploy` only applies pending migrations; it never drops data.
export default async function setup(): Promise<void> {
  try { process.loadEnvFile('.env'); } catch { /* CI provides env vars directly */ }
  const owner = process.env.TEST_DATABASE_OWNER_URL;
  if (!owner) throw new Error('TEST_DATABASE_OWNER_URL is required for tests');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_OWNER_URL: owner },
  });
  // The local key provider's ticket key (derived from LOCAL_MASTER_KEY), installed
  // the way infra/server/ticket-key.sh installs keyd's in production.
  const master = Buffer.from(process.env.LOCAL_MASTER_KEY ?? '', 'base64');
  if (master.length !== 32) throw new Error('LOCAL_MASTER_KEY (32 bytes, base64) is required for tests');
  const db = new pg.Client({ connectionString: owner });
  await db.connect();
  try {
    await db.query('SELECT tv_install_ticket_key($1)', [localTicketKey(master)]);
  } finally {
    await db.end();
  }
}
