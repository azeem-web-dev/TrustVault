import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { Tx } from '../db/prisma.service.js';
import { type Actor, currentContext } from '../common/request-context.js';
import { ipAllowed, normalizeIp } from '../common/ip.js';
import { type AccessWindow, describeWindow, inWindow } from './schedule.js';

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
  capture_attempt: Level.VIEW, // report a likely screen capture of those pages (V11)
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
  override: Level.OWNER,     // emergency exception to a share's conditions
} as const;

export type DocAction = keyof typeof REQUIRED_LEVEL;

/** Actions allowed on a document in the trash (owner only, see evaluate). */
const TRASH_ACTIONS: ReadonlySet<DocAction> = new Set(['view', 'view_pages', 'download', 'restore', 'purge', 'view_history']);

/** Actions that only read: they share the document's lock (see require()). */
const READ_ONLY: ReadonlySet<DocAction> = new Set(['view', 'view_pages', 'capture_attempt', 'download', 'offline_key']);

/** Conditions a share (or a role) puts on access: THREATS.md P1-P12. */
export interface AccessConditions {
  window?: AccessWindow | null;
  networks?: string[] | null;
}

export interface GrantFacts extends AccessConditions {
  level: 'VIEW' | 'READ' | 'EDIT' | 'MANAGE';
  expiresAt: string | null;
  viaGroup: boolean;
  /** Downloads through this share need an approval. */
  downloadApproval?: boolean;
}

/** Raw facts from tv_access_facts(); no decision has been made yet. */
export interface AccessFacts {
  document: { ownerId: string; status: 'ACTIVE' | 'DELETED' } | null;
  user: { role: 'ADMIN' | 'OWNER' | 'VIEWER' | 'EXTERNAL'; status: 'ACTIVE' | 'DEACTIVATED' | 'INVITED'; accessExpiresAt: string | null } | null;
  grants: GrantFacts[];
  breakGlassUntil: string | null;
  /** Organisation-wide rules for the user's role (administrators set them). */
  rolePolicy?: AccessConditions | null;
  /** An owner's emergency exception for this user on this document. */
  overrideUntil?: string | null;
}

/** Where the request comes from: the client IP as derived by Express (trusted proxy only). */
export interface RequestOrigin {
  ip: string | null;
}

export interface Decision {
  allowed: boolean;
  level: Level;
  reason: string;
  /** The bytes need a download approval (THREATS.md P8). */
  approvalRequired?: boolean;
  /** Why a share that exists did not count; shown to the person. */
  policyMessage?: string;
}

/** Refusals caused by an access policy rather than by having no share. */
export const POLICY_REASONS: ReadonlySet<string> = new Set(['outside_time_window', 'network_not_allowed']);

const GRANT_LEVEL = { VIEW: Level.VIEW, READ: Level.READ, EDIT: Level.EDIT, MANAGE: Level.MANAGE } as const;

/**
 * Does a live grant count right now? The role rules first (an owner's
 * exception never lifts them), then the share's own window and network,
 * unless the owner gave an exception. Null when usable, else why not.
 */
export function grantBlocked(g: AccessConditions, facts: AccessFacts, now: Date, origin: RequestOrigin): { reason: string; message: string } | null {
  const role = facts.rolePolicy;
  if (role) {
    if (role.window && !inWindow(role.window, now)) return { reason: 'outside_time_window', message: `Your role can open shared documents only ${describeWindow(role.window)}` };
    if (!ipAllowed(role.networks, origin.ip)) return { reason: 'network_not_allowed', message: 'Your role can open shared documents only from approved networks' };
  }
  if (facts.overrideUntil && new Date(facts.overrideUntil) > now) return null;
  if (g.window && !inWindow(g.window, now)) return { reason: 'outside_time_window', message: `This share is available only ${describeWindow(g.window)}` };
  if (!ipAllowed(g.networks, origin.ip)) return { reason: 'network_not_allowed', message: 'This share can be opened only from approved networks' };
  return null;
}

interface Effective {
  level: Level;
  reason: string;
  approvalRequired?: boolean;
  policyMessage?: string;
}

/** Effective level of `userId` on the document described by `facts`. Pure. */
export function effectiveLevel(facts: AccessFacts, userId: string, now: Date, origin: RequestOrigin = { ip: null }): Effective {
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
  let blocked: { reason: string; message: string } | null = null;
  // Downloads need an approval unless a usable share that allows
  // downloading does not ask for one, or the owner gave an exception.
  let freeDownload = Boolean(facts.overrideUntil && new Date(facts.overrideUntil) > now);
  for (const g of facts.grants) {
    if (g.expiresAt && new Date(g.expiresAt) <= now) continue;          // expired grant
    if (g.viaGroup && user.role === 'EXTERNAL') continue;               // externals never get access through groups
    const why = grantBlocked(g, facts, now, origin);
    if (why) { blocked ??= why; continue; }                             // outside its time window or network
    level = Math.max(level, GRANT_LEVEL[g.level]);
    // VIEW never downloads, so a VIEW share without approval frees nothing.
    if (!g.downloadApproval && GRANT_LEVEL[g.level] >= Level.READ) freeDownload = true;
  }
  if (user.role === 'EXTERNAL') level = Math.min(level, Level.READ);    // externals: read at most
  if (level === Level.NONE && blocked) return { level, reason: blocked.reason, policyMessage: blocked.message };
  return { level, reason: level > Level.NONE ? 'grant' : 'no_grant', approvalRequired: level >= Level.READ && !freeDownload };
}

/** Is `action` allowed? Pure: same facts, same answer. */
export function evaluate(facts: AccessFacts, userId: string, action: DocAction, now: Date = new Date(), origin: RequestOrigin = { ip: null }): Decision {
  const { level, reason, approvalRequired, policyMessage } = effectiveLevel(facts, userId, now, origin);
  if (level === Level.NONE) return { allowed: false, level, reason, ...(policyMessage ? { policyMessage } : {}) };
  if (facts.document?.status === 'DELETED' && !TRASH_ACTIONS.has(action)) {
    return { allowed: false, level, reason: 'document_in_trash' };
  }
  const needed = REQUIRED_LEVEL[action];
  if (level < needed) return { allowed: false, level, reason: `needs_${Level[needed].toLowerCase()}` };
  return { allowed: true, level, reason, approvalRequired: approvalRequired === true };
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
    // Time windows and network rules need the client address (THREATS.md P5).
    const origin: RequestOrigin = { ip: normalizeIp(currentContext()?.ip) };
    let decision = evaluate(state!.facts, actor.userId, action, new Date(), origin);
    // The session was checked before the lock; a password reset or sign-out
    // everywhere that committed since then ends it here too.
    if (decision.allowed && !state!.session_live) decision = { allowed: false, level: Level.NONE, reason: 'session_ended' };
    if (!decision.allowed) {
      const policy = POLICY_REASONS.has(decision.reason);
      await this.audit.record({
        action: `document.${action}`,
        outcome: 'DENIED',
        reason: decision.reason,
        targetType: 'document',
        targetId: documentId,
        documentId: decision.reason === 'no_such_document' ? undefined : documentId,
        ...(policy ? { details: { ip: origin.ip } } : {}),
      });
      // Someone who holds a share, refused only by its time window or
      // network, is told why: they already know the document exists.
      if (policy) throw new ForbiddenException({ message: decision.policyMessage, code: decision.reason });
      throw new NotFoundException('Document not found');
    }
    return decision;
  }
}
