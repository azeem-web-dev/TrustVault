import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../db/prisma.service.js';
import { logger } from './logger.js';
import { currentContext, type RequestContext } from './request-context.js';

/** /api/documents/<uuid> and anything below it. */
const DOCUMENT_PATH = /^\/api\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/.*)?$/i;

/** Short, stable reason codes for refusals recorded by the filter. */
function reasonFor(status: number): string {
  switch (status) {
    case 400: return 'invalid_input';
    case 401: return 'unauthenticated';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 413: return 'too_large';
    case 415: return 'unsupported_media_type';
    case 422: return 'unprocessable';
    case 429: return 'rate_limited';
    default: return `http_${status}`;
  }
}

/**
 * The only place error responses are shaped. HTTP errors we raise on
 * purpose pass their (safe) message through. Anything else — database
 * errors, bugs — becomes a generic 500 with a request id; the details go to
 * the server log only, never to the client.
 *
 * It also closes the audit gap for document routes: a signed-in caller
 * refused with a 4xx on /api/documents/<id>... before (or outside) the
 * per-document authorisation check — rate limit, upload limits, body or
 * parameter validation, malformed id — gets one 'document.request_refused'
 * row, unless that refusal was already recorded for this request.
 */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private static audit: AuditService | null = null;
  private static prisma: PrismaService | null = null;

  /**
   * The filter is created with `new` in bootstrap.ts, outside the DI
   * container, so its dependencies are handed over by an injectable that is
   * always constructed (the global SecurityGuard).
   */
  static useAudit(audit: AuditService, prisma?: PrismaService): void {
    ErrorsFilter.audit = audit;
    if (prisma) ErrorsFilter.prisma = prisma;
  }

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request | undefined>();
    const ctx = currentContext();
    const requestId = ctx?.requestId;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      await this.auditRefusal(exception, status, req, ctx);
      const body = exception.getResponse();
      const payload: Record<string, unknown> =
        typeof body === 'string' ? { message: body } : { ...(body as Record<string, unknown>) };
      delete payload.error;
      delete payload.statusCode;
      res.status(status).json({ ...payload, requestId });
      return;
    }

    // Body-parser errors (malformed JSON, too large) carry a status.
    const maybe = exception as { status?: number; type?: string };
    if (typeof maybe?.status === 'number' && maybe.status >= 400 && maybe.status < 500) {
      await this.auditRefusal(exception, maybe.status, req, ctx);
      res.status(maybe.status).json({ message: 'Invalid request body', requestId });
      return;
    }

    logger.error({ err: exception, requestId }, 'unhandled error');
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: 'Internal error', requestId });
  }

  /** Never throws: a failure to record must not change the response. */
  private async auditRefusal(exception: unknown, status: number, req: Request | undefined, ctx: RequestContext | undefined): Promise<void> {
    try {
      const audit = ErrorsFilter.audit;
      if (!audit || !req || !ctx?.actor || ctx.refusalAudited) return;
      if (status < 400 || status >= 500) return;

      const path = (req.originalUrl ?? req.url ?? '').split('?')[0]!;
      const documentId = DOCUMENT_PATH.exec(path)?.[1]?.toLowerCase();
      const rejectedId = ctx.rejectedDocumentId;
      if (!documentId && rejectedId === undefined) return;

      // AccessService.require() records its own refusals and answers with
      // exactly this; docId() uses the same message for malformed ids, which
      // AccessService never saw, so those are still recorded here.
      if (exception instanceof NotFoundException && exception.message === 'Document not found' && rejectedId === undefined) return;

      // Refusals the document services record themselves (missing version,
      // quarantined file, malware) are already in the log for this request.
      if (documentId && ErrorsFilter.prisma) {
        const already = await ErrorsFilter.prisma.auditEvent.findFirst({
          where: { documentId, requestId: ctx.requestId, outcome: 'DENIED' },
          select: { seq: true },
        });
        if (already) return;
      }

      const reason = rejectedId !== undefined ? 'invalid_document_id' : reasonFor(status);
      await audit.record({
        action: 'document.request_refused',
        outcome: 'DENIED',
        reason,
        targetType: 'document',
        targetId: documentId ?? rejectedId!.slice(0, 64),
        documentId,
        details: { method: req.method, path: path.slice(0, 512), status },
      });
      ctx.refusalAudited = true;
    } catch (err) {
      logger.error({ err, requestId: ctx?.requestId }, 'failed to audit a refused document request');
    }
  }
}
