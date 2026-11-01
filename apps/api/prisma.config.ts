import { defineConfig } from 'prisma/config';

// Prisma 7 does not read .env by itself. Migrations always run as the schema
// owner; the running API uses DATABASE_URL (the low-privilege role) instead.
try {
  process.loadEnvFile('.env');
} catch {
  // On the server the variables come from the systemd environment file.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_OWNER_URL ?? '',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
