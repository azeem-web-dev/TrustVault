import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ENV, type Env } from './config/env.js';
import { PrismaService } from './db/prisma.service.js';
import { RedisService } from './redis/redis.service.js';
import { RateLimitService } from './redis/rate-limit.service.js';
import { KEY_PROVIDER, KeydKeyProvider, LocalKeyProvider, type KeyProvider } from './crypto/key-provider.js';
import { AuditService } from './audit/audit.service.js';
import { AuditAdminService } from './audit/audit-admin.service.js';
import { AuditAdminController } from './audit/audit-admin.controller.js';
import { PasswordService } from './auth/password.service.js';
import { SessionService } from './auth/session.service.js';
import { AuthService } from './auth/auth.service.js';
import { AuthController } from './auth/auth.controller.js';
import { MfaService } from './auth/mfa.service.js';
import { MfaController } from './auth/mfa.controller.js';
import { SecurityGuard } from './auth/security.guard.js';
import { UsersService } from './users/users.service.js';
import { UsersController } from './users/users.controller.js';
import { GroupsController } from './users/groups.controller.js';
import { DirectoryController } from './users/directory.controller.js';
import { AccessService } from './documents/access.js';
import { DocumentsService } from './documents/documents.service.js';
import { SharingService } from './documents/sharing.service.js';
import { DocumentsController } from './documents/documents.controller.js';
import { FoldersController } from './documents/folders.controller.js';
import { JobsService } from './jobs/jobs.service.js';
import { HealthController } from './health.controller.js';

export function createKeyProvider(env: Env): KeyProvider {
  return env.KEY_PROVIDER === 'keyd'
    ? new KeydKeyProvider(env.KEYD_SOCKET)
    : new LocalKeyProvider(Buffer.from(env.LOCAL_MASTER_KEY!, 'base64'));
}

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController, AuthController, MfaController, UsersController, GroupsController, DirectoryController,
        DocumentsController, FoldersController, AuditAdminController,
      ],
      providers: [
        { provide: ENV, useValue: env },
        { provide: KEY_PROVIDER, useValue: createKeyProvider(env) },
        PrismaService,
        RedisService,
        RateLimitService,
        AuditService,
        AuditAdminService,
        PasswordService,
        SessionService,
        AuthService,
        MfaService,
        UsersService,
        AccessService,
        DocumentsService,
        SharingService,
        JobsService,
        // Global: runs before every route. Deny-by-default authentication.
        { provide: APP_GUARD, useClass: SecurityGuard },
      ],
    };
  }
}
