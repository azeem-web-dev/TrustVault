import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

// Argon2id, 64 MiB memory, 3 passes. Above the OWASP minimum
// (19 MiB, 2 passes); roughly 100-200 ms per hash on the server, which is
// fine for logins (rate limited) and expensive for anyone with a stolen
// database.
const PRODUCTION_PARAMS = { algorithm: Algorithm.Argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
// The test suite creates hundreds of accounts; full-strength hashing there
// only makes it slow. Never used outside NODE_ENV=test (vitest sets it),
// and not by the login timing measurement (TV_REAL_ARGON2=1), which must
// time the real thing.
const TEST_PARAMS = { algorithm: Algorithm.Argon2id, memoryCost: 4096, timeCost: 1, parallelism: 1 } as const;
export const PARAMS = process.env.NODE_ENV === 'test' && process.env.TV_REAL_ARGON2 !== '1' ? TEST_PARAMS : PRODUCTION_PARAMS;

/** Length rules only: length beats composition rules, and 128 caps hashing cost. */
export const PasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

@Injectable()
export class PasswordService {
  // Hash of a random string, used when the account does not exist so that
  // "unknown email" takes as long as "wrong password".
  private dummyHash: Promise<string> = hash(randomBytes(32).toString('hex'), PARAMS);

  hash(password: string): Promise<string> {
    return hash(password, PARAMS);
  }

  async verify(passwordHash: string | null, password: string): Promise<boolean> {
    const target = passwordHash ?? (await this.dummyHash);
    try {
      const ok = await verify(target, password);
      return passwordHash !== null && ok;
    } catch {
      return false;
    }
  }
}
