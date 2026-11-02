import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { Tx } from '../db/prisma.service.js';
import type { Actor } from '../common/request-context.js';

/**
 * THE AUTHORISATION DECISION FOR DOCUMENTS.
 *
 * Every route that touches a document calls AccessService.require() before
 * doing anything else. It denies by default. A second, independent lock —
 * Postgres row-level security using tv_doc_level() — sits underneath, so a
 * bug here still returns nothing rather than someone else's file.
 */

export enum Level {
  NONE = 0,
  READ = 1,
  EDIT = 2,
  MANAGE = 3,
  OWNER = 4,
}

/** What each action needs. Anything not listed here cannot be performed. */
export const REQUIRED_LEVEL = {
  view: Level.READ,          // metadata and version list
  download: Level.READ,
  edit: Level.EDIT,          // title, category, description
  upload_version: Level.EDIT,
  view_access: Level.MANAGE, // who has access
  share: Level.MANAGE,       // grant and revoke
  view_history: Level.MANAGE,
  move_folder: Level.OWNER,
  trash: Level.OWNER,
  restore: Level.OWNER,
  purge: Level.OWNER,
  transfer: Level.OWNER,
} as const;

export type DocAction = keyof typeof REQUIRED_LEVEL;

/** Actions allowed on a document in the trash (owner only, see evaluate). */
const TRASH_ACTIONS: ReadonlySet<DocAction> = new Set(['view', 'download', 'restore', 'purge', 'view_history']);

/** Actions that only read: they share the document's lock (see require()). */
const READ_ONLY: ReadonlySet<DocAction> = new Set(['view', 'download']);

/** Raw facts from tv_access_facts(); no decision has been made yet. */
export interface AccessFacts {
  document: { ownerId: string; status: 'ACTIVE' | 'DELETED' } | null;
  user: { role: 'ADMIN' | 'OWNER' | 'VIEWER' | 'EXTERNAL'; status: 'ACTIVE' | 'DEACTIVATED' | 'INVITED'; accessExpiresAt: string | null } | null;
  grants: { level: 'READ' | 'EDIT' | 'MANAGE'; expiresAt: string | null; viaGroup: boolean }[];
  breakGlassUntil: string | null;
}

export interface Decision {
  allowed: boolean;
  level: Level;
  reason: string;
}

const GRANT_LEVEL = { READ: Level.READ, EDIT: Level.EDIT, MANAGE: Level.MANAGE } as const;

/** Effective level of `userId` on the document described by `facts`. Pure. */
export function effectiveLevel(facts: AccessFacts, userId: string, now: Date): { level: Level; reason: string } {
  const { document: doc, user } = facts;
  if (!doc) return { level: Level.NONE, reason: 'no_such_document' };
  if (!user) return { level: Level.NONE, reason: 'no_such_user' };
  if (user.status !== 'ACTIVE') return { level: Level.NONE, reason: 'user_inactive' };
  if (user.accessExpiresAt && new Date(user.accessExpiresAt) <= now) return { level: Level.NONE, reason: 'user_access_expired' };

  // Administrators manage people, not documents: no ownership, no grants,
  // no groups. Only an unexpired break-glass gives READ (THREATS.md A9, A17).
  if (user.role === 'ADMIN') {
    if (doc.status === 'ACTIVE' && facts.breakGlassUntil && new Date(facts.breakGlassUntil) > now) return { level: Level.READ, reason: 'break_glass' };
    return { level: Level.NONE, reason: 'admin_no_document_access' };
  }

  if (doc.ownerId === userId) return { level: Level.OWNER, reason: 'owner' };
  if (doc.status !== 'ACTIVE') return { level: Level.NONE, reason: 'document_deleted' };

  let level = Level.NONE;
  for (const g of facts.grants) {
    if (g.expiresAt && new Date(g.expiresAt) <= now) continue;          // expired grant
    if (g.viaGroup && user.role === 'EXTERNAL') continue;               // externals never get access through groups
    level = Math.max(level, GRANT_LEVEL[g.level]);
  }
  const reason = level > Level.NONE ? 'grant' : 'no_grant';
  if (user.role === 'EXTERNAL') level = Math.min(level, Level.READ);    // externals: read at most
  return { level, reason };
}

/** Is `action` allowed? Pure: same facts, same answer. */
export function evaluate(facts: AccessFacts, userId: string, action: DocAction, now: Date = new Date()): Decision {
  const { level, reason } = effectiveLevel(facts, userId, now);
  if (level === Level.NONE) return { allowed: false, level, reason };
  if (facts.document?.status === 'DELETED' && !TRASH_ACTIONS.has(action)) {
    return { allowed: false, level, reason: 'document_in_trash' };
  }
  const needed = REQUIRED_LEVEL[action];
  if (level < needed) return { allowed: false, level, reason: `needs_${Level[needed].toLowerCase()}` };
  return { allowed: true, level, reason };
}

@Injectable()
export class AccessService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  async facts(tx: Tx, documentId: string, userId: string): Promise<AccessFacts> {
    const rows = await tx.$queryRaw<{ facts: AccessFacts }[]>`SELECT tv_access_facts(${documentId}::uuid, ${userId}::uuid) AS facts`;
    return rows[0]!.facts;
  }

  /**
   * Allow or throw. A refusal is written to the audit log (kept even though
   * the request fails) and answered with 404, the same as a document that
   * does not exist, so the caller learns nothing about what is there.
   */
  async require(tx: Tx, actor: Actor, documentId: string, action: DocAction): Promise<Decision> {
    // One lock protocol for every document request (THREATS.md R10, R11):
    // the caller's user lock shared, then the document's lock — shared to
    // read, exclusive to change — both held until commit. Every change that
    // gives or takes away access holds the exclusive lock on the same
    // document or person until it commits (database triggers enforce it).
    // So a request decided after a revoke commits is refused, and one decided
    // before it finishes, audit row included, before the revoke can commit.
    // Reads still run in parallel with each other.
    await tx.$executeRaw`SELECT tv_lock_access(${actor.userId}::uuid, ${documentId}::uuid, ${!READ_ONLY.has(action)})`;
    const [state] = await tx.$queryRaw<{ facts: AccessFacts; session_live: boolean }[]>`
      SELECT tv_access_facts(${documentId}::uuid, ${actor.userId}::uuid) AS facts,
             EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
                      WHERE s.id = ${actor.sessionId}::uuid AND s.user_id = ${actor.userId}::uuid AND s.revoked_at IS NULL
                        AND s.expires_at > clock_timestamp() AND s.created_at >= u.password_changed_at) AS session_live`;
    let decision = evaluate(state!.facts, actor.userId, action);
    // The session was checked before the lock; a password reset or sign-out
    // everywhere that committed since then ends it here too.
    if (decision.allowed && !state!.session_live) decision = { allowed: false, level: Level.NONE, reason: 'session_ended' };
    if (!decision.allowed) {
      await this.audit.record({
        action: `document.${action}`,
        outcome: 'DENIED',
        reason: decision.reason,
        targetType: 'document',
        targetId: documentId,
        documentId: decision.reason === 'no_such_document' ? undefined : documentId,
      });
      throw new NotFoundException('Document not found');
    }
    return decision;
  }
}
