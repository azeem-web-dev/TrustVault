import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/decorators.js';

@Controller('health')
export class HealthController {
  /** Who may call: anyone. Reveals nothing but liveness. */
  @Public()
  @Get()
  health() {
    return { ok: true };
  }
}
