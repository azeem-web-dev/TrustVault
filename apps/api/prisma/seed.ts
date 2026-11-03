// Demo data: one protected account per role, two groups, and documents
// shared in different ways so every permission path can be tried.
//
// Safe to re-run: accounts that exist are left alone (only marked
// protected), and documents are only created if Olivia has none yet.
//
// Passwords: SEED_PASSWORD_ADMIN / _OWNER / _VIEWER / _EXTERNAL (required in
// production). The demo admin's authenticator secret: SEED_ADMIN_TOTP_SECRET
// (base32), printed at the end so it can be published in the README.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type { Role } from '../src/generated/prisma/enums.js';
import { PasswordService } from '../src/auth/password.service.js';
import { packWrapped } from '../src/auth/mfa.service.js';
import { base32Decode, base32Encode, newTotpSecret } from '../src/auth/totp.js';
import { createKeyProvider } from '../src/app.module.js';
import { loadEnv } from '../src/config/env.js';
import { blobAad, sealFile, sha256 } from '../src/crypto/file-crypto.js';

const env = loadEnv();
const isProd = env.NODE_ENV === 'production';
const DAY = 86_400_000;

function password(role: string): string {
  const value = process.env[`SEED_PASSWORD_${role}`];
  if (value) return value;
  if (isProd) throw new Error(`SEED_PASSWORD_${role} is required in production`);
  return `dev-only-${role.toLowerCase()}-password`;
}

const accounts: { key: string; email: string; displayName: string; role: Role; pw: string; expiresInDays?: number }[] = [
  { key: 'admin', email: 'admin@demo.com', displayName: 'Ada Admin', role: 'ADMIN', pw: 'ADMIN' },
  { key: 'olivia', email: 'olivia@demo.com', displayName: 'Olivia Owner', role: 'OWNER', pw: 'OWNER' },
  { key: 'oscar', email: 'oscar@demo.com', displayName: 'Oscar Owner', role: 'OWNER', pw: 'OWNER' },
  { key: 'victor', email: 'victor@demo.com', displayName: 'Victor Viewer', role: 'VIEWER', pw: 'VIEWER' },
  { key: 'erin', email: 'erin@demo.com', displayName: 'Erin External', role: 'EXTERNAL', pw: 'EXTERNAL', expiresInDays: 180 },
];

/** A small valid one-page PDF with plain text (no scripts, no active content). */
function makePdf(title: string, lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const text = [`BT /F1 18 Tf 60 760 Td (${esc(title)}) Tj ET`, ...lines.map((l, i) => `BT /F1 11 Tf 60 ${720 - i * 18} Td (${esc(l)}) Tj ET`)].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function main(): Promise<void> {
  // As the schema owner: the app's role may not create active, protected or
  // second-factor-enrolled accounts (THREATS.md A23).
  const owner = process.env.DATABASE_OWNER_URL;
  if (!owner) throw new Error('DATABASE_OWNER_URL is required: demo accounts are created as the schema owner');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: owner }) });
  const keys = createKeyProvider(env);
  const hasher = new PasswordService();
  const ids: Record<string, string> = {};

  try {
    // ---------------------------------------------------------- accounts
    for (const a of accounts) {
      const existing = await prisma.user.findUnique({ where: { email: a.email } });
      if (existing) {
        await prisma.user.update({ where: { id: existing.id }, data: { isProtected: true } });
        ids[a.key] = existing.id;
        console.log(`exists   ${a.role.padEnd(8)} ${a.email}`);
        continue;
      }
      const user = await prisma.user.create({
        data: {
          email: a.email, displayName: a.displayName, role: a.role, isProtected: true,
          passwordHash: await hasher.hash(password(a.pw)),
          accessExpiresAt: a.expiresInDays ? new Date(Date.now() + a.expiresInDays * DAY) : null,
        },
      });
      ids[a.key] = user.id;
      await prisma.auditEvent.create({ data: { action: 'user.create', outcome: 'ALLOWED', reason: 'seed', actorEmail: 'system', targetType: 'user', targetId: user.id, details: { email: a.email, role: a.role } } });
      console.log(`created  ${a.role.padEnd(8)} ${a.email}`);
    }

    // The demo admin needs a second factor like every admin. Its secret is
    // published in the README so judges can generate codes.
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin! } });
    let totpB32: string | null = null;
    if (!admin.totpEnabledAt) {
      const secret = process.env.SEED_ADMIN_TOTP_SECRET ? base32Decode(process.env.SEED_ADMIN_TOTP_SECRET) : newTotpSecret();
      const { wrapped, keyId } = await keys.wrap(secret, `tv-totp-v1|${admin.id}`);
      await prisma.user.update({ where: { id: admin.id }, data: { totpSecretEnc: new Uint8Array(packWrapped(keyId, wrapped)), totpEnabledAt: new Date(), totpLastStep: null } });
      totpB32 = base32Encode(secret);
    }

    // ------------------------------------------------------------ groups
    const group = async (name: string, description: string, members: string[]) => {
      const g = await prisma.group.upsert({ where: { name }, create: { name, description }, update: {} });
      for (const m of members) await prisma.groupMember.upsert({ where: { groupId_userId: { groupId: g.id, userId: m } }, create: { groupId: g.id, userId: m }, update: {} });
      return g.id;
    };
    const finance = await group('Finance', 'Finance team', [ids.victor!]);
    const engineering = await group('Engineering', 'Engineering team', [ids.victor!, ids.oscar!]);

    // --------------------------------------------------------- documents
    const asUser = async <T>(userId: string, fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
        return fn(tx);
      });

    const already = await asUser(ids.olivia!, (tx) => tx.document.count({ where: { ownerId: ids.olivia! } }));
    if (already === 0) {
      const docs: { owner: string; title: string; category: string; description: string; file: string; body: Buffer; grants: { userId?: string; groupId?: string; level: 'READ' | 'EDIT' | 'MANAGE'; days?: number }[] }[] = [
        { owner: 'olivia', title: 'Offer letter - Victor Viewer', category: 'HR', description: 'Shared with Victor only (READ).', file: 'offer-letter-victor.pdf',
          body: makePdf('Offer letter', ['Dear Victor,', 'We are pleased to offer you the position of Analyst.', 'Salary: confidential demo figure.', 'Only Victor and Olivia should be able to open this file.']),
          grants: [{ userId: ids.victor!, level: 'READ' }] },
        { owner: 'olivia', title: 'Salary bands 2026', category: 'HR', description: 'Private to Olivia. Nobody else has access.', file: 'salary-bands-2026.pdf',
          body: makePdf('Salary bands 2026', ['Band A ... Band F', 'This document is shared with nobody.', 'If you are not Olivia and you can read this, report it.']),
          grants: [] },
        { owner: 'olivia', title: 'Q3 board minutes', category: 'Board', description: 'Shared with the Finance group (READ).', file: 'q3-board-minutes.pdf',
          body: makePdf('Q3 board minutes', ['Attendees: board members', 'Item 1: results', 'Item 2: budget', 'Visible to members of the Finance group.']),
          grants: [{ groupId: finance, level: 'READ' }] },
        { owner: 'olivia', title: 'Partner NDA - Erin', category: 'Legal', description: 'Shared with external Erin, READ, expires in 30 days.', file: 'partner-nda.pdf',
          body: makePdf('Mutual non-disclosure agreement', ['Between TrustVault Demo Ltd and Partner Co.', 'External access expires automatically.']),
          grants: [{ userId: ids.erin!, level: 'READ', days: 30 }] },
        { owner: 'oscar', title: 'Architecture review', category: 'Engineering', description: 'Engineering group can EDIT; Olivia can MANAGE.', file: 'architecture-review.txt',
          body: Buffer.from('Architecture review\n\n- Sessions are server-side and checked on every request.\n- Two locks on every document: decide() and row-level security.\n'),
          grants: [{ groupId: engineering, level: 'EDIT' }, { userId: ids.olivia!, level: 'MANAGE' }] },
      ];

      for (const d of docs) {
        const ownerId = ids[d.owner]!;
        const ownerEmail = accounts.find((a) => a.key === d.owner)!.email;
        const documentId = randomUUID();
        const versionId = randomUUID();
        const sealed = await sealFile(keys, d.body, blobAad(documentId, versionId, 1));
        await asUser(ownerId, async (tx) => {
          await tx.document.create({ data: { id: documentId, ownerId, title: d.title, category: d.category, description: d.description } });
          await tx.documentVersion.create({
            data: { id: versionId, documentId, versionNo: 1, fileName: d.file, mimeType: d.file.endsWith('.pdf') ? 'application/pdf' : 'text/plain; charset=utf-8', sizeBytes: d.body.length, sha256: new Uint8Array(sha256(d.body)), uploadedById: ownerId },
          });
          await tx.documentBlob.create({ data: { versionId, wrappedKey: new Uint8Array(sealed.wrappedKey), keyId: sealed.keyId, nonce: new Uint8Array(sealed.nonce), authTag: new Uint8Array(sealed.authTag), ciphertext: new Uint8Array(sealed.ciphertext) } });
          await tx.auditEvent.create({ data: { action: 'document.upload', outcome: 'ALLOWED', reason: 'seed', actorId: ownerId, actorEmail: ownerEmail, targetType: 'document', targetId: documentId, documentId, details: { title: d.title, fileName: d.file } } });
          for (const g of d.grants) {
            const row = await tx.grant.create({
              data: { documentId, userId: g.userId ?? null, groupId: g.groupId ?? null, level: g.level, expiresAt: g.days ? new Date(Date.now() + g.days * DAY) : null, grantedById: ownerId },
            });
            await tx.auditEvent.create({ data: { action: 'access.grant', outcome: 'ALLOWED', reason: 'seed', actorId: ownerId, actorEmail: ownerEmail, targetType: 'grant', targetId: row.id, documentId, details: { level: g.level, userId: g.userId ?? null, groupId: g.groupId ?? null } } });
          }
        });
        console.log(`document ${d.owner.padEnd(7)} ${d.title}`);
      }
    }

    if (totpB32) console.log(`\nDemo admin authenticator secret (publish in README): ${totpB32}`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
