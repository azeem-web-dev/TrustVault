import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { currentContext, type Actor } from '../common/request-context.js';
import { NotifyService } from '../mail/notify.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { InviteService } from './invite.service.js';
import { CurrentActor, PartialAuth, Public } from './decorators.js';
import { AuthService } from './auth.service.js';
import { PasswordSchema } from './password.service.js';
import { SESSION_COOKIE, type NewSession } from './session.service.js';

const LoginSchema = z.strictObject({
  email: z.string().max(254),
  // Not PasswordSchema: old passwords may predate the current rules. The
  // max length still caps Argon2 work per request.
  password: z.string().min(1).max(1024),
});

const ChangePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(1024),
  newPassword: PasswordSchema,
});

const ForgotSchema = z.strictObject({ email: z.string().trim().min(3).max(254) });
const ResetSchema = z.strictObject({ token: z.string().max(100), newPassword: z.string().min(1).max(1024) });
const InviteCheckSchema = z.strictObject({ token: z.string().max(100) });
const InviteAcceptSchema = z.strictObject({
  token: z.string().max(100),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(1024),
});

const COOKIE_BASE = { httpOnly: true, secure: true, sameSite: 'strict' as const, path: '/' };

export function setSessionCookie(res: Response, session: NewSession): void {
  res.cookie(SESSION_COOKIE, session.token, { ...COOKIE_BASE, expires: session.expiresAt });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, COOKIE_BASE);
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(NotifyService) private readonly notify: NotifyService,
    @Inject(PasswordResetService) private readonly resets: PasswordResetService,
    @Inject(InviteService) private readonly invites: InviteService,
  ) {}

  /**
   * Who may call: anyone (this is how a session is obtained). If the account
   * needs a second factor, the session returned can only reach the MFA
   * routes until it is presented (`mfaRequired: true`).
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const previous = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const { session, user, mfa } = await this.auth.login(body.email, body.password, previous);
    setSessionCookie(res, session);
    // Without a second step this is the moment of signing in; with one, the
    // notice goes out when the second step succeeds.
    if (!mfa.required) this.notify.signIn(user.id, currentContext()?.ip ?? null, currentContext()?.userAgent ?? null);
    return { user, csrfToken: session.csrfToken, mfaRequired: mfa.required, mfaEnrolled: mfa.enrolled, mfaMethods: mfa.methods };
  }

  /** Who may call: any signed-in user, even before the second factor (ends their own session). */
  @PartialAuth()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(actor);
    clearSessionCookie(res);
  }

  /** Who may call: any signed-in user, even before the second factor (own profile, CSRF token, MFA state). */
  @PartialAuth()
  @Get('me')
  async me(@CurrentActor() actor: Actor) {
    return {
      user: await this.auth.me(actor),
      csrfToken: actor.csrfToken,
      mfaRequired: actor.mfaRequired,
      mfaSatisfied: actor.authLevel === 'mfa',
      mfaEnrolled: actor.mfaEnrolled,
    };
  }

  /** Who may call: any fully signed-in user, for their own password. Ends all their sessions. */
  @Post('password')
  @HttpCode(204)
  async changePassword(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(ChangePasswordSchema)) body: z.infer<typeof ChangePasswordSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.changePassword(actor, body.currentPassword, body.newPassword);
    clearSessionCookie(res);
    this.notify.passwordChanged(actor.userId, 'from your account settings');
  }

  /**
   * Who may call: anyone. Emails a reset link if the account exists and can
   * be reset. Always answers 202, so it cannot reveal which emails exist.
   */
  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  async forgot(@Body(new ZodPipe(ForgotSchema)) body: z.infer<typeof ForgotSchema>) {
    await this.resets.request(body.email);
    return { ok: true };
  }

  /** Who may call: anyone holding a valid, unused, unexpired reset link. Ends every session. */
  @Public()
  @Post('password/reset')
  @HttpCode(204)
  async reset(@Body(new ZodPipe(ResetSchema)) body: z.infer<typeof ResetSchema>, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.resets.reset(body.token, body.newPassword);
    clearSessionCookie(res);
  }

  /**
   * Who may call: anyone holding a valid, unused, unexpired invitation link.
   * Says which email and role it is for, so the page can show it. `400` otherwise.
   */
  @Public()
  @Post('invite/check')
  @HttpCode(200)
  async checkInvite(@Body(new ZodPipe(InviteCheckSchema)) body: z.infer<typeof InviteCheckSchema>) {
    return await this.invites.check(body.token);
  }

  /** Who may call: anyone holding a valid invitation link. Sets their name and password; then they sign in. */
  @Public()
  @Post('invite/accept')
  @HttpCode(204)
  async acceptInvite(@Body(new ZodPipe(InviteAcceptSchema)) body: z.infer<typeof InviteAcceptSchema>, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.invites.accept(body.token, body.displayName, body.password);
    clearSessionCookie(res);
  }
}
