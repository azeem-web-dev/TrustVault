import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ENV, type Env } from './config/env.js';
import { PrismaService } from './db/prisma.service.js';
import { RedisService } from './redis/redis.service.js';
import { AuditService } from './audit/audit.service.js';
import { PasswordService } from './auth/password.service.js';
import { SessionService } from './auth/session.service.js';
import { AuthService } from './auth/auth.service.js';
import { AuthController } from './auth/auth.controller.js';
import { SecurityGuard } from './auth/security.guard.js';
import { UsersService } from './users/users.service.js';
import { UsersController } from './users/users.controller.js';
import { HealthController } from './health.controller.js';

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, UsersController],
      providers: [
        { provide: ENV, useValue: env },
        PrismaService,
        RedisService,
        AuditService,
        PasswordService,
        SessionService,
        AuthService,
        UsersService,
        // Global: runs before every route. Deny-by-default authentication.
        { provide: APP_GUARD, useClass: SecurityGuard },
      ],
    };
  }
}
