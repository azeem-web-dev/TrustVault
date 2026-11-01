import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Actor } from '../common/request-context.js';
import { CurrentActor, Public } from './decorators.js';
import { AuthService } from './auth.service.js';
import { PasswordSchema } from './password.service.js';
import { SESSION_COOKIE } from './session.service.js';

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

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** Who may call: anyone (this is how a session is obtained). */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const previous = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const { session, user } = await this.auth.login(body.email, body.password, previous);
    res.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      expires: session.expiresAt,
    });
    return { user, csrfToken: session.csrfToken };
  }

  /** Who may call: any signed-in user (ends their own current session). */
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(actor);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
  }

  /** Who may call: any signed-in user (their own profile and CSRF token). */
  @Get('me')
  async me(@CurrentActor() actor: Actor) {
    return { user: await this.auth.me(actor), csrfToken: actor.csrfToken };
  }

  /** Who may call: any signed-in user, for their own password. Ends all their sessions. */
  @Post('password')
  @HttpCode(204)
  async changePassword(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(ChangePasswordSchema)) body: z.infer<typeof ChangePasswordSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.changePassword(actor, body.currentPassword, body.newPassword);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
  }
}
