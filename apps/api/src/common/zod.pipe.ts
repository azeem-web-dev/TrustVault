import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a request body/query against a Zod schema. Schemas are strict
 * objects, so unknown keys (e.g. `ownerId`, `role`) are rejected rather than
 * silently passed through — this is the mass-assignment defence.
 */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Invalid request',
        // Unknown-key messages would repeat the caller's key names back: a
        // generic message instead, so no error echoes input (THREATS.md W6).
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.code === 'unrecognized_keys' ? 'Unrecognized field' : i.message })),
      });
    }
    return result.data;
  }
}
