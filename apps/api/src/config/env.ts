import { z } from 'zod';

// Every setting the API reads, validated once at startup. A missing or
// malformed value stops the process instead of failing later at runtime.
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

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
  /** Where long-lived keys live. `keyd` (separate process) is required in production. */
  KEY_PROVIDER: z.enum(['local', 'keyd']).default('local'),
  /** 32 random bytes, base64. Development and tests only. */
  LOCAL_MASTER_KEY: z.string().optional(),
  KEYD_SOCKET: z.string().default('/run/tvkeyd/keyd.sock'),
  /** Malware scanning of uploads. `clamd` is required in production. */
  SCANNER: z.enum(['none', 'clamd']).default('none'),
  /** clamd socket path, or tcp://host:port. */
  CLAMD_SOCKET: z.string().default('/run/clamav/clamd.ctl'),
  CLAMD_TIMEOUT_MS: z.coerce.number().int().min(500).max(300_000).default(60_000),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(25),
  /** Documents in the trash longer than this are permanently removed. */
  TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** Minimum response time of a failed login, so timing does not reveal which emails have accounts. */
  LOGIN_FAILURE_FLOOR_MS: z.coerce.number().int().min(0).max(5000).default(450),
  /** Background jobs (audit checkpoints, retention, session cleanup). */
  JOBS_ENABLED: bool.default(true),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Print which keys are wrong, never their values (they may be secrets).
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid configuration: ${keys}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (!env.PUBLIC_ORIGIN.startsWith('https://')) throw new Error('Invalid configuration: PUBLIC_ORIGIN must be https in production');
    if (env.KEY_PROVIDER !== 'keyd') throw new Error('Invalid configuration: production requires KEY_PROVIDER=keyd');
    if (env.SCANNER !== 'clamd') throw new Error('Invalid configuration: production requires SCANNER=clamd');
  }
  if (env.KEY_PROVIDER === 'local') {
    const key = env.LOCAL_MASTER_KEY ? Buffer.from(env.LOCAL_MASTER_KEY, 'base64') : null;
    if (!key || key.length !== 32) throw new Error('Invalid configuration: LOCAL_MASTER_KEY must be 32 bytes of base64');
  }
  return env;
}

export const ENV = Symbol('ENV');
