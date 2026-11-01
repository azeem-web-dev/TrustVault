import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { logger } from './logger.js';
import { currentContext } from './request-context.js';

/**
 * The only place error responses are shaped. HTTP errors we raise on
 * purpose pass their (safe) message through. Anything else — database
 * errors, bugs — becomes a generic 500 with a request id; the details go to
 * the server log only, never to the client.
 */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = currentContext()?.requestId;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
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
      res.status(maybe.status).json({ message: 'Invalid request body', requestId });
      return;
    }

    logger.error({ err: exception, requestId }, 'unhandled error');
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: 'Internal error', requestId });
  }
}
