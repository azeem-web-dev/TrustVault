import { type CallHandler, type ExecutionContext, ForbiddenException, HttpException, Inject, Injectable, type NestInterceptor, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { catchError, from, type Observable, switchMap, throwError } from 'rxjs';
import { currentContext } from '../common/request-context.js';
import { DocumentsService } from './documents.service.js';

/** Stable reason codes for refusals that happen before the service sees the file. */
function reasonFor(status: number): string {
  switch (status) {
    case 400: return 'invalid_input';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 413: return 'too_large';
    case 415: return 'unsupported_media_type';
    case 422: return 'unprocessable';
    case 429: return 'rate_limited';
    case 503: return 'unavailable';
    default: return `http_${status}`;
  }
}

/**
 * Wraps the upload routes (POST /documents, POST /documents/:id/versions)
 * OUTSIDE the multipart interceptor, so it sees every way an upload can be
 * refused after the security guard: multer's size and part limits (413,
 * 400), body validation, the upload rate limit, a missing folder, and
 * anything the service throws. DocumentsService audits the refusals it
 * knows best (content check, sanitization, scanner) with their own reason
 * codes and marks the request as audited; this writes the row for
 * everything else (THREATS.md A-row on refused uploads). Refusals
 * AccessService already recorded (404 "Document not found", 403 with a
 * policy code) are left to it.
 */
@Injectable()
export class UploadRefusalInterceptor implements NestInterceptor {
  constructor(@Inject(DocumentsService) private readonly docs: DocumentsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { file?: { buffer?: Buffer; originalname?: string; size?: number } }>();
    return next.handle().pipe(
      catchError((err: unknown) => from(this.record(err, req)).pipe(switchMap(() => throwError(() => err)))),
    );
  }

  private async record(err: unknown, req: Request & { file?: { buffer?: Buffer; originalname?: string; size?: number } }): Promise<void> {
    const ctx = currentContext();
    if (!ctx?.actor || ctx.refusalAudited || ctx.rejectedDocumentId !== undefined) return;
    if (err instanceof NotFoundException && err.message === 'Document not found') return;
    if (err instanceof ForbiddenException && typeof (err.getResponse() as { code?: unknown })?.code === 'string') return;
    const documentId = typeof req.params?.id === 'string' ? req.params.id : undefined;
    const status = err instanceof HttpException ? err.getStatus() : 500;
    const message = err instanceof HttpException ? err.message : 'Internal error';
    const length = Number(req.get?.('content-length'));
    await this.docs.recordUploadRefusal({
      action: documentId ? 'document.upload_version' : 'document.upload',
      outcome: status >= 500 ? 'FAILED' : 'DENIED',
      reason: status === 500 ? 'internal_error' : reasonFor(status),
      message,
      file: req.file,
      sizeBytes: req.file ? undefined : (Number.isFinite(length) ? length : undefined),
      documentId,
      extra: { status },
    });
  }
}
