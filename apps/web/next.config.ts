import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // In development the browser talks to Next on :3000 and Next forwards
  // /api to the API on :4100, so cookies stay same-origin. In production
  // nginx sends /api straight to the API and Next never sees it.
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    return [{ source: '/api/:path*', destination: 'http://127.0.0.1:4100/api/:path*' }];
  },
};

export default config;
