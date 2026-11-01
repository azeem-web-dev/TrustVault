import { loadEnv } from './config/env.js';
import { createApp } from './bootstrap.js';
import { logger } from './common/logger.js';

const env = loadEnv();
const app = await createApp(env);
// Loopback only: the public reaches the API through nginx, never directly.
await app.listen(env.PORT, '127.0.0.1');
logger.info({ port: env.PORT }, 'TrustVault API listening');
