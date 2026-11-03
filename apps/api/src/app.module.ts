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
import { WitnessController } from './audit/witness.controller.js';
import { PasswordService } from './auth/password.service.js';
import { SessionService } from './auth/session.service.js';
import { AuthService } from './auth/auth.service.js';
import { DeviceTrustService } from './auth/device-trust.service.js';
import { LoginThrottleService } from './auth/login-throttle.service.js';
import { SignInLinkService } from './auth/signin-link.service.js';
import { AuthController } from './auth/auth.controller.js';
import { MfaService } from './auth/mfa.service.js';
import { MfaController } from './auth/mfa.controller.js';
import { SecurityGuard } from './auth/security.guard.js';
import { MfaPolicyService } from './auth/mfa-policy.service.js';
import { SessionsController } from './auth/sessions.controller.js';
import { SettingsController } from './auth/settings.controller.js';
import { UsersService } from './users/users.service.js';
import { UsersController } from './users/users.controller.js';
import { GroupsController } from './users/groups.controller.js';
import { DirectoryController } from './users/directory.controller.js';
import { ApprovalsController } from './users/approvals.controller.js';
import { ApprovalsService } from './users/approvals.service.js';
import { AccessService } from './documents/access.js';
import { DocumentsService } from './documents/documents.service.js';
import { SharingService } from './documents/sharing.service.js';
import { ViewingService } from './documents/viewing.service.js';
import { CaptureReportService } from './documents/capture-report.service.js';
import { DocumentsController } from './documents/documents.controller.js';
import { FoldersController } from './documents/folders.controller.js';
import { DownloadApprovalsService } from './documents/download-approvals.service.js';
import { AccessPolicyService } from './documents/access-policy.service.js';
import { DownloadRequestsController, RolePoliciesController } from './documents/policies.controller.js';
import { JobsService } from './jobs/jobs.service.js';
import { MailService } from './mail/mail.service.js';
import { NotifyService } from './mail/notify.service.js';
import { PasswordResetService } from './auth/password-reset.service.js';
import { InviteService } from './auth/invite.service.js';
import { RescanService } from './scanning/rescan.service.js';
import { ClamdScanner, MALWARE_SCANNER, NoScanner, type MalwareScanner } from './scanning/malware-scanner.js';
import { HealthController } from './health.controller.js';
import { KeyLedgerService } from './keys/key-ledger.service.js';
import { KeydAdminController, KeydWitnessController } from './keys/key-ledger.controller.js';
import { RiskController } from './risk/risk.controller.js';
import { AlertStoreService } from './risk/alert-store.service.js';
import { AlertGeneratorService } from './risk/alert-generator.service.js';
import { RiskSettingsService } from './risk/risk-settings.service.js';
import { DownloadLimitsService } from './risk/download-limits.service.js';
import { RiskNotifyService } from './risk/risk-notify.service.js';
import { DownloadLifecycleService } from './risk/download-lifecycle.service.js';

export function createKeyProvider(env: Env): KeyProvider {
  return env.KEY_PROVIDER === 'keyd'
    ? new KeydKeyProvider(env.KEYD_SOCKET)
    : new LocalKeyProvider(Buffer.from(env.LOCAL_MASTER_KEY!, 'base64'));
}

export function createScanner(env: Env): MalwareScanner {
  return env.SCANNER === 'clamd' ? new ClamdScanner(env.CLAMD_SOCKET, env.CLAMD_TIMEOUT_MS) : new NoScanner();
}

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController, AuthController, MfaController, UsersController, GroupsController, DirectoryController, ApprovalsController,
        DocumentsController, FoldersController, AuditAdminController, WitnessController,
        SessionsController, SettingsController,
        DownloadRequestsController, RolePoliciesController,
        KeydAdminController, KeydWitnessController,
        RiskController,
      ],
      providers: [
        { provide: ENV, useValue: env },
        { provide: KEY_PROVIDER, useValue: createKeyProvider(env) },
        { provide: MALWARE_SCANNER, useValue: createScanner(env) },
        PrismaService,
        RedisService,
        RateLimitService,
        AuditService,
        AuditAdminService,
        KeyLedgerService,
        PasswordService,
        SessionService,
        MfaPolicyService,
        AuthService,
        DeviceTrustService,
        LoginThrottleService,
        SignInLinkService,
        MfaService,
        UsersService,
        ApprovalsService,
        AccessService,
        DocumentsService,
        SharingService,
        ViewingService,
        CaptureReportService,
        DownloadApprovalsService,
        AccessPolicyService,
        JobsService,
        RescanService,
        MailService,
        NotifyService,
        PasswordResetService,
        InviteService,
        // Insider-extraction detection: alerts, thresholds, download limits.
        AlertStoreService,
        AlertGeneratorService,
        RiskSettingsService,
        DownloadLimitsService,
        RiskNotifyService,
        DownloadLifecycleService,
        // Global: runs before every route. Deny-by-default authentication.
        { provide: APP_GUARD, useClass: SecurityGuard },
      ],
    };
  }
}
