import { AsyncResource } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service.js';
import { logger } from '../common/logger.js';

export interface ReleasedDownload {
  downloadId: string;
  documentId: string;
  versionNo: number;
  bytes: number;
}

/**
 * Download lifecycle (THREATS.md U10, docs/API.md "Download lifecycle"):
 *
 *   authorized  document.download ALLOWED — committed BEFORE the first byte
 *               leaves; if it cannot be written, nothing is sent. Bytes start
 *               flowing right after it, so it also marks "started".
 *   completed   document.download_completed — every byte was handed to the
 *               operating system's network stack ('finish'). It does NOT
 *               prove the recipient received, saved or read the file.
 *   interrupted document.download_interrupted — the connection closed first
 *               (client went away, network dropped); bytesSent says roughly
 *               how far it got. Part of the file may have been received.
 *   failed      document.integrity FAILED — decryption or the hash check
 *               failed after authorisation; nothing was sent.
 *
 * All carry the same downloadId. The completion events are written after
 * the response, so they can never delay or block it, and their absence
 * (a crash) leaves the authorisation event as the record: "may have been
 * received". Same events for the web app and the Android app (same route).
 */
@Injectable()
export class DownloadLifecycleService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  track(res: Response, d: ReleasedDownload): void {
    const socket = res.socket;
    const startBytes = socket?.bytesWritten ?? 0;
    let done = false;
    const record = AsyncResource.bind((completed: boolean) => {
      if (done) return;
      done = true;
      const sent = Math.max(0, (socket?.bytesWritten ?? startBytes) - startBytes);
      this.audit.record({
        action: completed ? 'document.download_completed' : 'document.download_interrupted',
        outcome: completed ? 'ALLOWED' : 'FAILED',
        reason: completed ? 'all_bytes_handed_to_network' : 'connection_closed_early',
        targetType: 'document', targetId: d.documentId, documentId: d.documentId,
        details: { downloadId: d.downloadId, versionNo: d.versionNo, fileBytes: d.bytes, bytesSent: sent },
      }).catch((err: unknown) => logger.warn({ err: (err as Error).message, downloadId: d.downloadId }, 'download lifecycle event not recorded'));
    });
    res.once('finish', () => record(true));
    res.once('close', () => record(res.writableFinished));
  }
}
