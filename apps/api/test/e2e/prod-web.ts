import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';

/**
 * The web app as it runs in production: `next build` + `next start`, with a
 * small reverse proxy in front that does what nginx does (infra/nginx/
 * vault.conf): /api/ goes to the API, everything else to Next. Production
 * matters here: the CSP differs from development (no 'unsafe-eval', no
 * 'unsafe-inline' styles) and React runs its production build.
 *
 * Set E2E_SKIP_BUILD=1 to reuse an existing build (CI builds once, earlier).
 */
export const WEB_DIR = resolve(__dirname, '../../../web');

export interface ProdWeb {
  origin: string;
  stop: () => Promise<void>;
}

async function waitFor(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (r.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
}

function killTree(p: ChildProcess | undefined) {
  if (!p?.pid) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-p.pid);
  } catch { /* already gone */ }
}

export async function startProdWeb(opts: { port: number; nextPort: number; apiPort: number }): Promise<ProdWeb> {
  if (process.env.E2E_SKIP_BUILD !== '1' || !existsSync(resolve(WEB_DIR, '.next/BUILD_ID'))) {
    execSync('npx next build', { cwd: WEB_DIR, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production' } });
  }
  const next = spawn('npx', ['next', 'start', '-p', String(opts.nextPort), '-H', '127.0.0.1'], {
    cwd: WEB_DIR, shell: true, stdio: 'ignore', detached: process.platform !== 'win32', env: { ...process.env, NODE_ENV: 'production' },
  });

  const proxy = http.createServer((req, res) => {
    const toApi = req.url!.startsWith('/api/');
    const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '', 'x-forwarded-proto': 'http' };
    const up = http.request({ host: '127.0.0.1', port: toApi ? opts.apiPort : opts.nextPort, path: req.url, method: req.method, headers }, (r) => {
      // nginx: add_header Strict-Transport-Security ... always (server level).
      res.writeHead(r.statusCode!, { ...r.headers, 'strict-transport-security': 'max-age=63072000; includeSubDomains' });
      r.pipe(res);
    });
    up.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
  await new Promise<void>((ok) => proxy.listen(opts.port, '127.0.0.1', ok));
  const origin = `http://localhost:${opts.port}`;
  await waitFor(`http://127.0.0.1:${opts.nextPort}/login`, 120_000);
  return {
    origin,
    stop: async () => {
      killTree(next);
      await new Promise((ok) => proxy.close(() => ok(undefined)));
    },
  };
}
