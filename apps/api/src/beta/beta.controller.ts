import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../auth/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { BetaService } from './beta.service.js';

const SignupSchema = z.strictObject({ email: z.string().trim().min(3).max(254).email() });

@Controller('beta')
export class BetaController {
  constructor(@Inject(BetaService) private readonly beta: BetaService) {}

  /**
   * Who may call: anyone. Emails the Android beta steps. Always 202 for a
   * valid address (new, repeat or capped), so it reveals nothing.
   */
  @Public()
  @Post('signup')
  @HttpCode(202)
  async signup(@Body(new ZodPipe(SignupSchema)) body: z.infer<typeof SignupSchema>) {
    await this.beta.signup(body.email);
    return { ok: true };
  }
}
