import { defineConfig } from 'vitest/config';

// Login timing measurement (not part of the normal suite: it is slow on
// purpose, using production-strength Argon2). Run: npm run measure:timing
export default defineConfig({
  test: {
    include: ['test/timing/*.measure.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: { TV_REAL_ARGON2: '1' },
    testTimeout: 30 * 60_000,
    hookTimeout: 120_000,
  },
});
