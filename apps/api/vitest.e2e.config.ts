import { defineConfig } from 'vitest/config';

// Browser end-to-end tests (test/e2e/*.e2e.ts): real Chrome, real Next.js
// pages, real API. Separate from the main suite because they need Chrome
// and start the web app; run with `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
