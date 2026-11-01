import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Actor } from '../common/request-context.js';
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

const COOKIE_BASE = { httpOnly: true, secure: true, sameSite: 'strict' as const, path: '/' };

export function setSessionCookie(res: Response, session: NewSession): void {
  res.cookie(SESSION_COOKIE, session.token, { ...COOKIE_BASE, expires: session.expiresAt });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, COOKIE_BASE);
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

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
  }
}
