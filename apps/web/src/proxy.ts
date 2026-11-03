import { NextResponse, type NextRequest } from 'next/server';

/**
 * Sets a strict Content-Security-Policy on every page with a fresh nonce.
 * Only scripts carrying this request's nonce run, so an injected <script>
 * (stored XSS through a file name, say) is refused by the browser.
 */
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV === 'development';
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Production: no 'unsafe-inline' for styles. Next emits stylesheets as
    // <link>s and React sets style props through the CSSOM (not affected);
    // the few server-rendered style attributes became classes. Development
    // keeps 'unsafe-inline': the dev server injects <style> tags for hot reload.
    dev ? `style-src 'self' 'unsafe-inline'` : `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  // Every page is per-user and dynamic: never stored by a browser or proxy.
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const config = {
  matcher: [{ source: '/((?!api|_next/static|_next/image|favicon.ico).*)' }],
};
