# TrustVault

A document platform where the wrong person can never read the file, and you can prove who read it.

**Live:** https://vault.rayyanazeem.cloud

> **Status (2026-11-01):** accounts, sessions, roles, admin user management, the tamper-evident audit log and the deployment are done and tested. Documents, sharing, search and the admin activity view are next. [docs/PLAN.md](docs/PLAN.md) has the full plan.

## Demo accounts (live site)

| Role | Email | Password |
|---|---|---|
| Admin | admin@trustvault.demo | `Demo-admin-b4401f3310b7` |
| Owner | olivia.owner@trustvault.demo | `Demo-owner-32d56b2cda22` |
| Owner | oscar.owner@trustvault.demo | `Demo-owner-32d56b2cda22` |
| Viewer | victor.viewer@trustvault.demo | `Demo-viewer-354fb61f99cd` |
| External | erin.external@partner.demo | `Demo-external-956110021bd0` |

These are published on purpose, because the brief asks for them. See THREATS.md I7 and I8 for what that costs and how it is contained.

## What to read

- [docs/PLAN.md](docs/PLAN.md): stack, permission model, revocation, audit design, what I chose not to build
- [THREATS.md](THREATS.md): how it could be broken, what I did about each, what I accepted
- [PROMPTS.md](PROMPTS.md): how I used AI and where it was wrong

## Run it locally

Needs Node 22+, PostgreSQL 16 and Redis 7.

```bash
git clone https://github.com/azeem-web-dev/TrustVault.git && cd TrustVault
npm ci
cp apps/api/.env.example apps/api/.env      # fill in the database and Redis URLs
cd apps/api
npx prisma migrate deploy                   # runs as DATABASE_OWNER_URL
npx tsx --env-file=.env prisma/seed.ts      # demo accounts, dev-only passwords
npm run dev                                 # API on http://127.0.0.1:4100
# in a second terminal, from the repo root:
npm run dev:web                             # web on http://localhost:3000
```

The database needs two roles: an owner for migrations, and a low-privilege app role that is a member of `trustvault_app`. `infra/server/provision.sh` creates both, plus the Redis ACL users.

### Tests

```bash
cd apps/api && npx vitest run
```

The tests run against a real Postgres and Redis (`TEST_DATABASE_URL`, `TEST_DATABASE_OWNER_URL`, `REDIS_URL`). They include direct-to-database attacks on the audit log.

## Deploy (Ubuntu 24.04)

```bash
sudo bash infra/server/provision.sh     # users, databases, roles, pg_hba, Redis ACL
sudo bash infra/server/install-app.sh   # env files, systemd units, nginx, TLS
sudo bash infra/server/deploy.sh        # fetch, build, migrate, restart, health check
```
