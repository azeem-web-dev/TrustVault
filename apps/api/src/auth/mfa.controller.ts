import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { currentContext, type Actor } from '../common/request-context.js';
import { NotifyService } from '../mail/notify.service.js';
import { CurrentActor, PartialAuth, StepUp } from './decorators.js';
import { MfaService } from './mfa.service.js';
import { setSessionCookie } from './auth.controller.js';
import type { NewSession } from './session.service.js';
import { DeviceTrustService } from './device-trust.service.js';

const CodeSchema = z.strictObject({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });
// WebAuthn responses are verified cryptographically by the library; here we
// only bound their size and shape.
const WebAuthnResponse = z.looseObject({ id: z.string().max(1024), rawId: z.string().max(1024), type: z.literal('public-key'), response: z.looseObject({}) });
const RegisterSchema = z.strictObject({ response: WebAuthnResponse, name: z.string().trim().min(1).max(60) });
const VerifySchema = z.strictObject({ response: WebAuthnResponse });
const StepUpSchema = z.union([CodeSchema, VerifySchema]);

/**
 * Who may call: any signed-in user, including one who has only passed the
 * password step (@PartialAuth) — these routes are how the second step is
 * completed or a first factor enrolled.
 */
@Controller('auth/mfa')
@PartialAuth()
export class MfaController {
  constructor(
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(NotifyService) private readonly notify: NotifyService,
    @Inject(DeviceTrustService) private readonly devices: DeviceTrustService,
  ) {}

  @Get()
  status(@CurrentActor() actor: Actor) {
    return this.mfa.status(actor);
  }

  @Post('totp/setup')
  @HttpCode(200)
  setupTotp(@CurrentActor() actor: Actor) {
    return this.mfa.setupTotp(actor);
  }

  @Post('totp/enable')
  @HttpCode(200)
  async enableTotp(@CurrentActor() actor: Actor, @Body(new ZodPipe(CodeSchema)) body: z.infer<typeof CodeSchema>, @Res({ passthrough: true }) res: Response) {
    const session = await this.mfa.enableTotp(actor, body.code);
    this.notify.secondFactorChanged(actor.userId, 'An authenticator app was added to your account. You will be asked for its code when you sign in.');
    return this.issue(res, session, actor);
  }

  @Post('totp/verify')
  @HttpCode(200)
  async verifyTotp(@CurrentActor() actor: Actor, @Body(new ZodPipe(CodeSchema)) body: z.infer<typeof CodeSchema>, @Res({ passthrough: true }) res: Response) {
    return this.issue(res, await this.mfa.verifyTotp(actor, body.code), actor);
  }

  @Post('passkeys/register/options')
  @HttpCode(200)
  registerOptions(@CurrentActor() actor: Actor) {
    return this.mfa.passkeyRegistrationOptions(actor);
  }

  @Post('passkeys/register')
  @HttpCode(200)
  async register(@CurrentActor() actor: Actor, @Body(new ZodPipe(RegisterSchema)) body: z.infer<typeof RegisterSchema>, @Res({ passthrough: true }) res: Response) {
    const session = await this.mfa.passkeyRegister(actor, body.response as never, body.name);
    this.notify.secondFactorChanged(actor.userId, `A passkey named “${body.name}” was added to your account.`);
    return session ? this.issue(res, session, actor) : { csrfToken: actor.csrfToken };
  }

  @Post('passkeys/options')
  @HttpCode(200)
  authOptions(@CurrentActor() actor: Actor) {
    return this.mfa.passkeyAuthOptions(actor);
  }

  @Post('passkeys/verify')
  @HttpCode(200)
  async verifyPasskey(@CurrentActor() actor: Actor, @Body(new ZodPipe(VerifySchema)) body: z.infer<typeof VerifySchema>, @Res({ passthrough: true }) res: Response) {
    return this.issue(res, await this.mfa.passkeyVerify(actor, body.response as never), actor);
  }

  /**
   * Step-up: a fresh code or passkey assertion (from POST passkeys/options)
   * before a risky action. Full sessions only; the token is kept (THREATS.md S20).
   */
  @Post('step-up')
  @HttpCode(200)
  async stepUp(@CurrentActor() actor: Actor, @Body(new ZodPipe(StepUpSchema)) body: z.infer<typeof StepUpSchema>) {
    await this.mfa.stepUp(actor, 'code' in body ? { code: body.code } : { response: body.response as never });
    return { ok: true };
  }

  /** Turns the authenticator app off. Needs a fresh second factor. */
  @Delete('totp')
  @HttpCode(204)
  @StepUp()
  async removeTotp(@CurrentActor() actor: Actor): Promise<void> {
    await this.mfa.removeTotp(actor);
    this.notify.secondFactorChanged(actor.userId, 'The authenticator app was removed from your account.');
  }

  @Delete('passkeys/:id')
  @HttpCode(204)
  @StepUp()
  async remove(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<void> {
    if (!z.uuid().safeParse(id).success) throw new NotFoundException('Passkey not found');
    await this.mfa.removePasskey(actor, id);
    this.notify.secondFactorChanged(actor.userId, 'A passkey was removed from your account.');
  }

  private issue(res: Response, session: NewSession, actor: Actor) {
    setSessionCookie(res, session);
    // Completing the second step is the moment of signing in, and this
    // browser becomes a trusted device for the account (DeviceTrustService).
    if (actor.authLevel !== 'mfa') {
      this.devices.setCookie(res, actor.userId);
      const ctx = currentContext();
      this.notify.signIn(actor.userId, ctx?.ip ?? null, ctx?.userAgent ?? null);
    }
    return { csrfToken: session.csrfToken, mfa: true };
  }
}
