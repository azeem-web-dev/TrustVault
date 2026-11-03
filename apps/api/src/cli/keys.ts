#!/usr/bin/env node
/**
 * Key maintenance for operators (docs/KEYS.md). Run on the server as the
 * trustvault user (keyd only answers that uid), with the schema OWNER's
 * database URL, which the API itself never has:
 *
 *   sudo -u trustvault env DATABASE_OWNER_URL="$(sed -n 's/^DATABASE_OWNER_URL=//p' /etc/trustvault/migrate.env)" \
 *     KEY_PROVIDER=keyd node /opt/trustvault/app/apps/api/dist/cli/keys.js <command>
 *
 * Commands:
 *   status               generations, ticket key ids, which key ids protect how many values
 *   rotate [--batch N]   re-wrap every document data key and TOTP secret under keyd's current
 *                        generation (keyd re-wraps internally; resumable, idempotent), then verify
 *   verify               every wrapped value opens and is on the current generation (exit 1 if not)
 *   reencrypt [--batch N] [--max N]
 *                        EMERGENCY: new data key and new ciphertext for every stored version;
 *                        needs KEYD_LIMIT_MAINT_PER_HOUR raised in keyd for the duration
 *   install-ticket-key   reads keyd's ticket key (raw 32 bytes or base64) on stdin and installs it
 *                        in the database (deactivating any other)
 *
 * Exit code 0 = done and verified, 1 = something failed (details printed), 2 = usage.
 */
import pg from 'pg';
import { KeydKeyProvider, LocalKeyProvider, type KeyProvider } from '../crypto/key-provider.js';
import { installTicketKey, reencryptAll, rotateKeys, verifyKeys } from '../keys/rotation.js';

function provider(): KeyProvider {
  if (process.env.KEY_PROVIDER === 'keyd') return new KeydKeyProvider(process.env.KEYD_SOCKET ?? '/run/tvkeyd/keyd.sock');
  const master = Buffer.from(process.env.LOCAL_MASTER_KEY ?? '', 'base64');
  if (master.length !== 32) throw new Error('set KEY_PROVIDER=keyd (production) or LOCAL_MASTER_KEY (development)');
  return new LocalKeyProvider(master, { limits: { maintPerHour: 1_000_000 } });
}

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(name);
  const v = i > 0 ? Number(process.argv[i + 1]) : dflt;
  if (!Number.isInteger(v) || v < 1) throw new Error(`${name} must be a positive whole number`);
  return v;
};

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const url = process.env.DATABASE_OWNER_URL;
  if (!cmd || !['status', 'rotate', 'verify', 'reencrypt', 'install-ticket-key'].includes(cmd) || !url) {
    console.error('usage: DATABASE_OWNER_URL=... [KEY_PROVIDER=keyd] node dist/cli/keys.js status|rotate|verify|reencrypt|install-ticket-key');
    return 2;
  }
  const db = new pg.Client({ connectionString: url, options: '-c TimeZone=UTC' });
  await db.connect();
  const log = (m: string) => console.log(m);
  try {
    if (cmd === 'install-ticket-key') {
      console.log(`installed ticket key ${await installTicketKey(db, await readStdin())}`);
      return 0;
    }
    const keys = provider();
    if (cmd === 'status') {
      const s = await keys.status();
      const { rows } = await db.query<{ key_id: string; n: string }>('SELECT key_id, n::text FROM tv_key_usage() ORDER BY key_id');
      const { rows: kids } = await db.query<{ kid: string; active: boolean }>('SELECT kid, active FROM keyd_ticket_keys ORDER BY created_at');
      console.log(JSON.stringify({ keyService: s, databaseTicketKeys: kids, wrappedValues: rows }, null, 2));
      const active = kids.find((k) => k.active)?.kid;
      if (!active || !s.ticketKids.includes(active)) {
        console.log('PROBLEM: the active database ticket key is not loaded by the key service; downloads will fail');
        return 1;
      }
      return 0;
    }
    if (cmd === 'rotate') {
      const r = await rotateKeys(db, keys, { batch: arg('--batch', 100), log });
      const v = await verifyKeys(db, keys, { log });
      const failed = r.blobs.failed.length + r.totp.failed.length;
      for (const f of [...r.blobs.failed, ...r.totp.failed].slice(0, 20)) console.log(`  failed: ${f}`);
      console.log(failed || !v.ok ? 'ROTATION INCOMPLETE: run again; see failures above' : `rotation complete: everything is on ${r.target.blob} / ${r.target.totp}`);
      return failed || !v.ok ? 1 : 0;
    }
    if (cmd === 'verify') {
      const v = await verifyKeys(db, keys, { log });
      for (const id of [...v.blobs.broken, ...v.totp.broken].slice(0, 20)) console.log(`  does not open: ${id}`);
      return v.ok ? 0 : 1;
    }
    const r = await reencryptAll(db, keys, { batch: arg('--batch', 20), maxVersions: arg('--max', Number.MAX_SAFE_INTEGER), log });
    for (const f of r.failed.slice(0, 20)) console.log(`  failed: ${f}`);
    console.log(r.done && !r.failed.length ? `re-encryption run ${r.run} complete: ${r.reencrypted} versions` : `re-encryption run ${r.run} not complete; run again to continue`);
    return r.done && !r.failed.length ? 0 : 1;
  } finally {
    await db.end();
  }
}

main().then((code) => process.exit(code), (err: unknown) => {
  console.error(`keys: ${(err as Error).message}`);
  process.exit(1);
});
