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

// Same numbers as tv_doc_level() in the database. VIEW sits below READ:
// see the document and its rendered pages, never the original bytes.
export enum Level {
  NONE = 0,
  VIEW = 1,
  READ = 2,
  EDIT = 3,
  MANAGE = 4,
  OWNER = 5,
}

/** What each action needs. Anything not listed here cannot be performed. */
export const REQUIRED_LEVEL = {
  view: Level.VIEW,          // metadata and version list
  view_pages: Level.VIEW,    // watermarked page images (THREATS.md V2)
  download: Level.READ,      // the original bytes: never VIEW (THREATS.md V1)
  offline_key: Level.READ,   // key for the Android app's encrypted copy (V6)
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
const TRASH_ACTIONS: ReadonlySet<DocAction> = new Set(['view', 'view_pages', 'download', 'restore', 'purge', 'view_history']);

/** Actions that only read: no per-document lock (see require()). */
const READ_ONLY: ReadonlySet<DocAction> = new Set(['view', 'view_pages', 'download', 'offline_key']);

/** Raw facts from tv_access_facts(); no decision has been made yet. */
export interface AccessFacts {
  document: { ownerId: string; status: 'ACTIVE' | 'DELETED' } | null;
  user: { role: 'ADMIN' | 'OWNER' | 'VIEWER' | 'EXTERNAL'; status: 'ACTIVE' | 'DEACTIVATED'; accessExpiresAt: string | null } | null;
  grants: { level: 'VIEW' | 'READ' | 'EDIT' | 'MANAGE'; expiresAt: string | null; viaGroup: boolean }[];
  breakGlassUntil: string | null;
}

export interface Decision {
  allowed: boolean;
  level: Level;
  reason: string;
}

const GRANT_LEVEL = { VIEW: Level.VIEW, READ: Level.READ, EDIT: Level.EDIT, MANAGE: Level.MANAGE } as const;

/** Effective level of `userId` on the document described by `facts`. Pure. */
export function effectiveLevel(facts: AccessFacts, userId: string, now: Date): { level: Level; reason: string } {
  const { document: doc, user } = facts;
  if (!doc) return { level: Level.NONE, reason: 'no_such_document' };
  if (!user) return { level: Level.NONE, reason: 'no_such_user' };
  if (user.status !== 'ACTIVE') return { level: Level.NONE, reason: 'user_inactive' };
  if (user.accessExpiresAt && new Date(user.accessExpiresAt) <= now) return { level: Level.NONE, reason: 'user_access_expired' };

  // Administrators manage people, not documents: no ownership, no grants,
  // no groups. Only an unexpired break-glass gives VIEW: an emergency look
  // at the pages, never the original file (THREATS.md A9, A17, V9).
  if (user.role === 'ADMIN') {
    if (doc.status === 'ACTIVE' && facts.breakGlassUntil && new Date(facts.breakGlassUntil) > now) return { level: Level.VIEW, reason: 'break_glass' };
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
    // Anything that changes a document or its access takes a per-document lock
    // first, held until commit. A revoke and an upload by the person being
    // revoked are then ordered: the upload either finished before the revoke,
    // or is decided after it and refused (THREATS.md R10). Reads stay parallel.
    if (!READ_ONLY.has(action)) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${documentId}::text, 0))`;
    }
    const decision = evaluate(await this.facts(tx, documentId, actor.userId), actor.userId, action);
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
