import { ForbiddenException } from '@nestjs/common';

/**
 * DEMO_MODE (THREATS.md I15). Every visitor signs in with the same published
 * accounts, so one visitor must not be able to change what the next one can
 * do. A setting that would lock the demo accounts out is refused with this.
 */
export const demoModeRefusal = (what: string): ForbiddenException =>
  new ForbiddenException({
    message: `This is the shared public demo, so ${what} is turned off here: it would lock the demo accounts out for everyone else.`,
    code: 'demo_mode',
  });
