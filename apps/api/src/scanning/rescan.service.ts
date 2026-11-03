import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { KEY_PROVIDER, type KeyProvider } from '../crypto/key-provider.js';
import { blobAad, openFile, sha256 } from '../crypto/file-crypto.js';
import { issueUnwrapTicket, keyServiceRefusal } from '../crypto/tickets.js';
import { MALWARE_SCANNER, ScannerUnavailable, type MalwareScanner } from './malware-scanner.js';
import { logger } from '../common/logger.js';

export interface RescanResult {
  scanned: number;
  infected: number;
  alreadyQuarantined: number;
  integrityFailures: number;
  signatures: string | null;
  /** True when every stored version has been looked at. */
  done: boolean;
  /** Where the next run continues when not done. */
  cursor: string | null;
  stoppedBecause?: string;
}

const SYSTEM = { actorId: null, actorEmail: 'system' } as const;

/** keyd would not release a key (cap reached, ledger unwritable, unreachable). */
class KeyServiceRefused extends Error {}

/**
 * Re-scans every stored file with the scanner's current signatures.
 *
 * Uploads are scanned before storage, but a virus too new to have a
 * signature passes that check. ClamAV updates its signatures several times
 * a day, so the scheduler runs this nightly: anything that was unknown at
 * upload time is found as soon as ClamAV learns it. A version found
 * infected is quarantined (downloads refused from then on), and both the
 * finding and every run are audited and raised as admin alerts.
 *
 * A pass that runs out of time records where it stopped in its audit
 * event, and the next run continues from there. If the scanner stops
 * answering, the run stops; nothing is assumed clean.
 */
@Injectable()
export class RescanService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  /** Cursor left by the previous unfinished pass, if any. */
  private async resumeFrom(): Promise<string | null> {
    const last = await this.prisma.auditEvent.findFirst({ where: { action: 'malware.rescan' }, orderBy: { seq: 'desc' }, select: { details: true } });
    const d = last?.details as { done?: boolean; cursor?: string | null } | null;
    return d && d.done === false && typeof d.cursor === 'string' && /^[0-9a-f-]{36}$/.test(d.cursor) ? d.cursor : null;
  }

  async run({ budgetMs = 2 * 60 * 60_000, batch = 50 }: { budgetMs?: number; batch?: number } = {}): Promise<RescanResult> {
    const started = Date.now();
    let cursor = await this.resumeFrom();
    const result: RescanResult = { scanned: 0, infected: 0, alreadyQuarantined: 0, integrityFailures: 0, signatures: null, done: false, cursor };

    try {
      result.signatures = await this.scanner.version();
      for (;;) {
        const rows = await this.prisma.$queryRaw<{ version_id: string; document_id: string; version_no: number }[]>`
          SELECT * FROM tv_rescan_queue(${cursor}::uuid, ${batch}::int)`;
        if (rows.length === 0) {
          result.done = true;
          cursor = null;
          break;
        }
        for (const v of rows) {
          await this.one(v, result);
          cursor = v.version_id;
          if (Date.now() - started > budgetMs) {
            result.stoppedBecause = 'time_budget';
            break;
          }
        }
        if (result.stoppedBecause) break;
      }
    } catch (err) {
      if (err instanceof KeyServiceRefused) {
        result.stoppedBecause = `key_service_${err.message}`;
        logger.error({ err }, 'rescan stopped: the key service refused');
      } else {
        if (!(err instanceof ScannerUnavailable)) throw err;
        result.stoppedBecause = 'malware_scanner_unavailable';
        logger.error({ err }, 'rescan stopped: scanner unavailable');
      }
    }
    result.cursor = cursor;
    await this.audit.record({
      ...SYSTEM, action: 'malware.rescan',
      outcome: result.stoppedBecause && result.stoppedBecause !== 'time_budget' ? 'FAILED' : 'ALLOWED',
      reason: result.stoppedBecause ?? (result.infected ? 'malware_detected' : 'clean'),
      details: { ...result, scanner: this.scanner.name, seconds: Math.round((Date.now() - started) / 1000) },
    });
    return result;
  }

  private async one(v: { version_id: string; document_id: string; version_no: number }, result: RescanResult): Promise<void> {
    const quarantined = await this.prisma.versionQuarantine.findUnique({ where: { versionId: v.version_id }, select: { versionId: true } });
    if (quarantined) {
      result.alreadyQuarantined++;
      return;
    }
    const [blob] = await this.prisma.$queryRaw<{ wrapped_key: Uint8Array; key_id: string; nonce: Uint8Array; auth_tag: Uint8Array; ciphertext: Uint8Array; sha256: Uint8Array }[]>`
      SELECT * FROM tv_rescan_blob(${v.version_id}::uuid)`;
    if (!blob) return; // purged since it was listed

    const where = { targetType: 'document', targetId: v.document_id, documentId: v.document_id } as const;
    // Every decryption by the re-scan is an audited, ticketed key release
    // like a download (system actor, action 'rescan'); keyd caps how many
    // it allows per hour (docs/KEYS.md).
    const ticket = await this.prisma.$transaction(async (tx) => {
      const event = await this.audit.record({ ...SYSTEM, ...where, action: 'document.rescan_decrypt', outcome: 'ALLOWED', reason: 'malware_rescan', details: { versionNo: v.version_no } }, tx);
      return issueUnwrapTicket(tx, v.version_id, 'rescan', event.id);
    });
    let plaintext: Buffer;
    try {
      plaintext = await openFile(this.keys, {
        wrappedKey: Buffer.from(blob.wrapped_key), keyId: blob.key_id, nonce: Buffer.from(blob.nonce),
        authTag: Buffer.from(blob.auth_tag), ciphertext: Buffer.from(blob.ciphertext),
      }, blobAad(v.document_id, v.version_id, v.version_no), ticket);
    } catch (err) {
      const refusal = keyServiceRefusal(err);
      // keyd refused (hourly cap reached) or is down: stop; the next run continues here.
      if (refusal) throw new KeyServiceRefused(refusal);
      result.integrityFailures++;
      await this.audit.record({ ...SYSTEM, ...where, action: 'document.integrity', outcome: 'FAILED', reason: 'decryption_failed', details: { versionNo: v.version_no, during: 'rescan' } });
      return;
    }
    if (!sha256(plaintext).equals(Buffer.from(blob.sha256))) {
      result.integrityFailures++;
      await this.audit.record({ ...SYSTEM, ...where, action: 'document.integrity', outcome: 'FAILED', reason: 'hash_mismatch', details: { versionNo: v.version_no, during: 'rescan' } });
      return;
    }

    const scan = await this.scanner.scan(plaintext); // ScannerUnavailable stops the run
    result.scanned++;
    if (scan.clean) return;

    result.infected++;
    await this.prisma.$transaction(async (tx) => {
      await tx.versionQuarantine.create({ data: { versionId: v.version_id, signature: scan.signature, scanner: this.scanner.name } });
      await this.audit.record({
        ...SYSTEM, ...where, action: 'document.quarantine', outcome: 'ALLOWED', reason: 'malware_detected',
        details: { versionNo: v.version_no, signature: scan.signature, sha256: Buffer.from(blob.sha256).toString('hex'), signatures: result.signatures },
      }, tx);
    });
  }
}
