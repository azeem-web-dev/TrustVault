import { z } from 'zod';

// Every setting the API reads, validated once at startup. A missing or
// malformed value stops the process instead of failing later at runtime.
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  /** The only browser origin allowed to make state-changing requests. */
  PUBLIC_ORIGIN: z.url(),
  DATABASE_URL: z.string().startsWith('postgresql://'),
  REDIS_URL: z.string().startsWith('redis://'),
  /** Every Redis key is prefixed; the Redis ACL only allows this prefix. */
  REDIS_PREFIX: z.string().min(1).default('tv:'),
  /** Idle timeout and absolute lifetime of a session, in minutes. */
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
  SESSION_ABSOLUTE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(12 * 60),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Print which keys are wrong, never their values (they may be secrets).
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid configuration: ${keys}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.PUBLIC_ORIGIN.startsWith('https://')) {
    throw new Error('Invalid configuration: PUBLIC_ORIGIN must be https in production');
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
