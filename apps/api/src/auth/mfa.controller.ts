import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Actor } from '../common/request-context.js';
import { CurrentActor, PartialAuth } from './decorators.js';
import { MfaService } from './mfa.service.js';
import { setSessionCookie } from './auth.controller.js';
import type { NewSession } from './session.service.js';

const CodeSchema = z.strictObject({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });
// WebAuthn responses are verified cryptographically by the library; here we
// only bound their size and shape.
const WebAuthnResponse = z.looseObject({ id: z.string().max(1024), rawId: z.string().max(1024), type: z.literal('public-key'), response: z.looseObject({}) });
const RegisterSchema = z.strictObject({ response: WebAuthnResponse, name: z.string().trim().min(1).max(60) });
const VerifySchema = z.strictObject({ response: WebAuthnResponse });

/**
 * Who may call: any signed-in user, including one who has only passed the
 * password step (@PartialAuth) — these routes are how the second step is
 * completed or a first factor enrolled.
 */
@Controller('auth/mfa')
@PartialAuth()
export class MfaController {
  constructor(@Inject(MfaService) private readonly mfa: MfaService) {}

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
    return this.issue(res, await this.mfa.enableTotp(actor, body.code));
  }

  @Post('totp/verify')
  @HttpCode(200)
  async verifyTotp(@CurrentActor() actor: Actor, @Body(new ZodPipe(CodeSchema)) body: z.infer<typeof CodeSchema>, @Res({ passthrough: true }) res: Response) {
    return this.issue(res, await this.mfa.verifyTotp(actor, body.code));
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
    return session ? this.issue(res, session) : { csrfToken: actor.csrfToken };
  }

  @Post('passkeys/options')
  @HttpCode(200)
  authOptions(@CurrentActor() actor: Actor) {
    return this.mfa.passkeyAuthOptions(actor);
  }

  @Post('passkeys/verify')
  @HttpCode(200)
  async verifyPasskey(@CurrentActor() actor: Actor, @Body(new ZodPipe(VerifySchema)) body: z.infer<typeof VerifySchema>, @Res({ passthrough: true }) res: Response) {
    return this.issue(res, await this.mfa.passkeyVerify(actor, body.response as never));
  }

  @Delete('passkeys/:id')
  @HttpCode(204)
  async remove(@CurrentActor() actor: Actor, @Param('id') id: string): Promise<void> {
    if (!z.uuid().safeParse(id).success) throw new NotFoundException('Passkey not found');
    await this.mfa.removePasskey(actor, id);
  }

  private issue(res: Response, session: NewSession) {
    setSessionCookie(res, session);
    return { csrfToken: session.csrfToken, mfa: true };
  }
}
