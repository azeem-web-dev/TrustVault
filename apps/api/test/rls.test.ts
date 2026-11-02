import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { appDb, ownerDb } from './helpers.js';

// The second lock, tested on its own: Postgres row-level security and the
// guard triggers, talking to the database directly as the app role with
// no API code involved. If decide() were deleted entirely, these rules
// would still hold.

let app: pg.Client;
let owner: pg.Client;
const id = () => randomUUID();
const ids = { alice: id(), bob: id(), vic: id(), erin: id(), adm: id(), gone: id() };
let doc: string;

async function asUser<T>(user: string | null, fn: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    if (user) await app.query(`SELECT set_config('app.user_id', $1, true)`, [user]);
    return await fn();
  } finally {
    await app.query('ROLLBACK');
  }
}

const count = async (sql: string, params: unknown[] = []) => Number((await app.query(sql, params)).rowCount);

beforeAll(async () => {
  app = appDb();
  owner = ownerDb();
  await app.connect();
  await owner.connect();
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

beforeEach(async () => {
  await owner.query('TRUNCATE sessions, users, groups CASCADE');
  const u = (uid: string, email: string, role: string, extra = '') =>
    owner.query(`INSERT INTO users (id, email, display_name, role, password_hash, updated_at${extra ? ', ' + extra.split('=')[0] : ''})
                 VALUES ($1, $2, $2, $3, 'x', now()${extra ? ', ' + extra.split('=')[1] : ''})`, [uid, email, role]);
  await u(ids.alice, 'alice@r.io', 'OWNER');
  await u(ids.bob, 'bob@r.io', 'OWNER');
  await u(ids.vic, 'vic@r.io', 'VIEWER');
  await u(ids.erin, 'erin@r.io', 'EXTERNAL', "access_expires_at=now() + interval '30 days'");
  await u(ids.adm, 'adm@r.io', 'ADMIN');
  await u(ids.gone, 'gone@r.io', 'VIEWER');
  doc = id();
  const ver = id();
  await owner.query(`INSERT INTO documents (id, owner_id, title, category, updated_at) VALUES ($1, $2, 'Secret', 'HR', now())`, [doc, ids.alice]);
  await owner.query(`INSERT INTO document_versions (id, document_id, version_no, file_name, mime_type, size_bytes, sha256, uploaded_by_id)
                     VALUES ($1, $2, 1, 's.pdf', 'application/pdf', 10, decode(repeat('00', 32), 'hex'), $3)`, [ver, doc, ids.alice]);
  await owner.query(`INSERT INTO document_blobs (version_id, wrapped_key, key_id, nonce, auth_tag, ciphertext)
                     VALUES ($1, '\\x00', 'k', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), '\\x00')`, [ver]);
});

const grantAs = (granter: string, user: string, level: string, expires: string | null = null) =>
  app.query(`INSERT INTO grants (id, document_id, user_id, level, expires_at, granted_by_id, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [id(), doc, user, level, expires, granter]);

describe('row-level security: no user, no rows', () => {
  it('without app.user_id the app role sees nothing in any document table', async () => {
    await asUser(null, async () => {
      for (const table of ['documents', 'document_versions', 'document_blobs', 'grants', 'folders', 'break_glass']) {
        expect(await count(`SELECT 1 FROM ${table}`), table).toBe(0);
      }
    });
  });

  it('a user with no grant sees no document, version, blob or grant', async () => {
    await asUser(ids.bob, async () => {
      expect(await count('SELECT 1 FROM documents')).toBe(0);
      expect(await count('SELECT 1 FROM document_versions')).toBe(0);
      expect(await count('SELECT 1 FROM document_blobs')).toBe(0);
      expect(await count(`SELECT 1 FROM documents WHERE id = $1`, [doc])).toBe(0);
    });
  });

  it('the owner sees their document, version and blob', async () => {
    await asUser(ids.alice, async () => {
      expect(await count('SELECT 1 FROM documents')).toBe(1);
      expect(await count('SELECT 1 FROM document_blobs')).toBe(1);
    });
  });

  it('the ADMIN role sees nothing without break-glass', async () => {
    await asUser(ids.adm, async () => {
      expect(await count('SELECT 1 FROM documents')).toBe(0);
    });
  });
});

describe('row-level security: writes', () => {
  it('a stranger cannot update or delete the document (0 rows affected)', async () => {
    await asUser(ids.bob, async () => {
      expect(await count(`UPDATE documents SET title = 'pwned' WHERE id = $1`, [doc])).toBe(0);
      expect(await count(`DELETE FROM documents WHERE id = $1`, [doc])).toBe(0);
    });
  });

  it('a stranger cannot grant themselves access', async () => {
    await asUser(ids.bob, async () => {
      await expect(grantAs(ids.bob, ids.bob, 'READ')).rejects.toThrow(/row-level security|lacks MANAGE/);
    });
  });

  it('nobody can write a grant in someone else’s name', async () => {
    await asUser(ids.vic, async () => {
      await expect(grantAs(ids.alice, ids.vic, 'MANAGE')).rejects.toThrow(/row-level security|only an active document owner/);
    });
  });

  it('a VIEWER cannot create documents, and nobody can create one owned by someone else', async () => {
    await asUser(ids.vic, async () => {
      await expect(app.query(`INSERT INTO documents (id, owner_id, title, category, updated_at) VALUES ($1, $2, 't', 'c', now())`, [id(), ids.vic])).rejects.toThrow(/row-level security|only an active document owner/);
    });
    await asUser(ids.bob, async () => {
      await expect(app.query(`INSERT INTO documents (id, owner_id, title, category, updated_at) VALUES ($1, $2, 't', 'c', now())`, [id(), ids.alice])).rejects.toThrow(/row-level security|only an active document owner/);
    });
  });
});

describe('guard triggers', () => {
  it('the database refuses external and admin group members, whatever the API does (A11, A17)', async () => {
    const g = id();
    await owner.query(`INSERT INTO groups (id, name) VALUES ($1, 'Guarded')`, [g]);
    for (const who of [ids.erin, ids.adm]) {
      await expect(app.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`, [g, who])).rejects.toThrow(/cannot be group members/);
    }
    await owner.query(`DELETE FROM groups WHERE id = $1`, [g]);
  });

  it('a READ grantee cannot update anything', async () => {
    await asUser(ids.alice, () => grantAs(ids.alice, ids.vic, 'READ'));
    await owner.query(`INSERT INTO grants (id, document_id, user_id, level, granted_by_id, updated_at) VALUES ($1, $2, $3, 'READ', $4, now())`, [id(), doc, ids.vic, ids.alice]);
    await asUser(ids.vic, async () => {
      expect(await count(`UPDATE documents SET title = 'x' WHERE id = $1`, [doc])).toBe(0);
    });
  });

  it('an EDIT grantee can rename but cannot take ownership or trash the document', async () => {
    await owner.query(`INSERT INTO grants (id, document_id, user_id, level, granted_by_id, updated_at) VALUES ($1, $2, $3, 'EDIT', $4, now())`, [id(), doc, ids.vic, ids.alice]);
    await asUser(ids.vic, async () => {
      expect(await count(`UPDATE documents SET title = 'Renamed' WHERE id = $1`, [doc])).toBe(1);
    });
    await asUser(ids.vic, async () => {
      await expect(app.query(`UPDATE documents SET owner_id = $1 WHERE id = $2`, [ids.bob, doc])).rejects.toThrow(/only the owner/);
    });
    await asUser(ids.vic, async () => {
      await expect(app.query(`UPDATE documents SET status = 'DELETED', deleted_at = now() WHERE id = $1`, [doc])).rejects.toThrow(/only the owner/);
    });
  });

  it('a MANAGE grantee can grant READ/EDIT but not MANAGE', async () => {
    await owner.query(`INSERT INTO grants (id, document_id, user_id, level, granted_by_id, updated_at) VALUES ($1, $2, $3, 'MANAGE', $4, now())`, [id(), doc, ids.vic, ids.alice]);
    await asUser(ids.vic, async () => {
      await grantAs(ids.vic, ids.bob, 'EDIT');
    });
    await asUser(ids.vic, async () => {
      await expect(grantAs(ids.vic, ids.bob, 'MANAGE')).rejects.toThrow(/only the owner can grant MANAGE/);
    });
  });

  it('external users get READ only and only with an expiry', async () => {
    await asUser(ids.alice, async () => {
      await expect(grantAs(ids.alice, ids.erin, 'EDIT', new Date(Date.now() + 86_400_000).toISOString())).rejects.toThrow(/external/);
    });
    await asUser(ids.alice, async () => {
      await expect(grantAs(ids.alice, ids.erin, 'READ', null)).rejects.toThrow(/external/);
    });
  });

  it('grants to deactivated users are refused', async () => {
    await owner.query(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [ids.gone]);
    await asUser(ids.alice, async () => {
      await expect(grantAs(ids.alice, ids.gone, 'READ')).rejects.toThrow(/inactive/);
    });
  });

  it('external users cannot be added to groups', async () => {
    const g = id();
    await owner.query(`INSERT INTO groups (id, name) VALUES ($1, 'G')`, [g]);
    await expect(app.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`, [g, ids.erin])).rejects.toThrow(/external/);
  });

  it('versions and blobs cannot be modified or deleted by the app role, even by the owner', async () => {
    await asUser(ids.alice, async () => {
      await expect(app.query(`UPDATE document_blobs SET ciphertext = '\\x01'`)).rejects.toThrow(/permission denied/);
    });
    await asUser(ids.alice, async () => {
      await expect(app.query(`DELETE FROM document_versions`)).rejects.toThrow(/permission denied/);
    });
  });
});

describe('tv_doc_level: the SQL access decision', () => {
  const level = async (user: string) => Number((await app.query(`SELECT tv_doc_level($1, $2) AS l`, [doc, user])).rows[0].l);

  it('owner 4, stranger 0', async () => {
    expect(await level(ids.alice)).toBe(4);
    expect(await level(ids.bob)).toBe(0);
  });

  it('expired grants count for nothing', async () => {
    await owner.query(`ALTER TABLE grants DISABLE TRIGGER grants_guard`);
    await owner.query(`INSERT INTO grants (id, document_id, user_id, level, expires_at, granted_by_id, updated_at) VALUES ($1, $2, $3, 'MANAGE', now() - interval '1 minute', $4, now())`, [id(), doc, ids.vic, ids.alice]);
    await owner.query(`ALTER TABLE grants ENABLE TRIGGER grants_guard`);
    expect(await level(ids.vic)).toBe(0);
  });

  it('group grants count for members, and stop when they leave', async () => {
    const g = id();
    await owner.query(`INSERT INTO groups (id, name) VALUES ($1, 'Team')`, [g]);
    await owner.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`, [g, ids.vic]);
    const gr = id();
    await owner.query(`INSERT INTO grants (id, document_id, group_id, level, granted_by_id, updated_at) VALUES ($1, $2, $3, 'EDIT', $4, now())`, [gr, doc, g, ids.alice]);
    // A group grant covers only members the sharer confirmed (THREATS.md A19).
    expect(await level(ids.vic)).toBe(0);
    await owner.query(`INSERT INTO grant_group_members (grant_id, user_id) VALUES ($1, $2)`, [gr, ids.vic]);
    expect(await level(ids.vic)).toBe(2);
    await owner.query(`DELETE FROM group_members WHERE user_id = $1`, [ids.vic]);
    expect(await level(ids.vic)).toBe(0);
  });

  it('deleted documents are invisible to everyone but the owner', async () => {
    await owner.query(`INSERT INTO grants (id, document_id, user_id, level, granted_by_id, updated_at) VALUES ($1, $2, $3, 'MANAGE', $4, now())`, [id(), doc, ids.vic, ids.alice]);
    await owner.query(`UPDATE documents SET status = 'DELETED', deleted_at = now() WHERE id = $1`, [doc]);
    expect(await level(ids.vic)).toBe(0);
    expect(await level(ids.alice)).toBe(4);
  });

  it('deactivated owners lose access to their own documents', async () => {
    await owner.query(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [ids.alice]);
    expect(await level(ids.alice)).toBe(0);
  });

  it('externals are capped at READ', async () => {
    await owner.query(`ALTER TABLE grants DISABLE TRIGGER grants_guard`);
    await owner.query(`INSERT INTO grants (id, document_id, user_id, level, expires_at, granted_by_id, updated_at) VALUES ($1, $2, $3, 'MANAGE', now() + interval '1 day', $4, now())`, [id(), doc, ids.erin, ids.alice]);
    await owner.query(`ALTER TABLE grants ENABLE TRIGGER grants_guard`);
    expect(await level(ids.erin)).toBe(1);
  });

  it('break-glass gives an admin READ for its window only', async () => {
    await owner.query(`INSERT INTO break_glass (id, admin_id, document_id, reason, expires_at) VALUES ($1, $2, $3, 'emergency reason long enough', now() + interval '30 minutes')`, [id(), ids.adm, doc]);
    expect(await level(ids.adm)).toBe(1);
  });
});
