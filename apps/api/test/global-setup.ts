import { execFileSync } from 'node:child_process';

// Bring the test database up to the latest migration before any test runs.
// `migrate deploy` only applies pending migrations; it never drops data.
export default function setup(): void {
  try { process.loadEnvFile('.env'); } catch { /* CI provides env vars directly */ }
  const owner = process.env.TEST_DATABASE_OWNER_URL;
  if (!owner) throw new Error('TEST_DATABASE_OWNER_URL is required for tests');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_OWNER_URL: owner },
  });
}
