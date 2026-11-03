import type { Tx } from '../db/prisma.service.js';

/**
 * Asks the database for an unwrap ticket (migration 20261103400000).
 *
 * Call it INSIDE the transaction that wrote the ALLOWED audit event for
 * this access, right after writing it, passing that event's id. The
 * function runs as the schema owner and checks, below the application:
 * the user's level on the document (tv_doc_level) for `action`, that the
 * audit event is fresh, ALLOWED, for this user/document/version/action and
 * not used before, and (for downloads) that the version is not quarantined.
 * It returns a 30-second, single-use ticket MACed with a key the
 * application role cannot read. keyd (or LocalKeyProvider) refuses to
 * unwrap a document data key without one.
 *
 * Adding a new decrypting path (page rendering, offline keys): add a row to
 * unwrap_actions (action, audit action, minimum level), write that audit
 * event in the access transaction, then call this with the new action.
 */
export async function issueUnwrapTicket(tx: Pick<Tx, '$queryRaw'>, versionId: string, action: string, auditEventId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ ticket: string }[]>`
    SELECT tv_issue_unwrap_ticket(${versionId}::uuid, ${action}, ${auditEventId}::uuid) AS ticket`;
  return rows[0]!.ticket;
}

/** True when `err` is the database refusing a ticket (the transaction was rolled back). */
export function isTicketRefusal(err: unknown): boolean {
  return err instanceof Error && err.message.includes('unwrap ticket refused');
}

/** The reason the database gave, e.g. "no access", "quarantined". */
export function ticketRefusalReason(err: unknown): string {
  const m = err instanceof Error ? /unwrap ticket refused: ([a-z ]+)/.exec(err.message) : null;
  return m ? m[1]!.trim() : 'refused';
}

const REFUSALS = [
  'ticket required', 'bad ticket mac', 'unknown ticket key', 'malformed ticket', 'ticket user does not fit its action',
  'ticket lifetime too long', 'ticket issued in the future', 'ticket expired', 'ticket is for another document version',
  'ticket is for another wrapped key', 'ticket already used', 'rate limited', 'cannot record unwrap',
];

/**
 * Why the key service refused before decrypting anything, or null when the
 * error is something else (a real decryption/integrity failure). keyd is
 * unreachable -> 'key_service_unavailable'.
 */
export function keyServiceRefusal(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'EACCES' || err.message === 'keyd timeout') return 'key_service_unavailable';
  const msg = err.message.replace(/^keyd: /, '');
  const hit = REFUSALS.find((r) => msg.startsWith(r));
  return hit ? hit.replace(/ /g, '_') : null;
}
