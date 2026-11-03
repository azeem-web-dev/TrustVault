import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { ErrorsFilter } from './common/errors.filter.js';
import { requestContextMiddleware } from './common/request-context.js';

/** Builds the configured app. Shared by main.ts and the tests. */
export async function createApp(env: Env): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), {
    bodyParser: false,
    logger: env.NODE_ENV === 'test' ? false : ['error', 'warn'],
  });

  // Only nginx on the same machine may set X-Forwarded-For; anything else
  // claiming to be a proxy is ignored, so clients cannot spoof their IP
  // to dodge rate limits, falsify the audit log or pass a network allowlist.
  // Express takes the right-most address not set by a trusted proxy.
  app.set('trust proxy', env.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean));
  app.disable('x-powered-by');

  app.use(requestContextMiddleware);
  app.use(
    helmet({
      // The API only ever returns JSON or file downloads: nothing may load, run or frame.
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], sandbox: [] } },
      frameguard: { action: 'deny' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: false },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  // Nothing the API returns should ever be stored by a browser or proxy.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  app.useBodyParser('json', { limit: '64kb', strict: true });
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ErrorsFilter());
  app.enableShutdownHooks();
  return app;
}
