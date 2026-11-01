// Thin client for the TrustVault API. The session lives in an HttpOnly
// cookie the page cannot read; the CSRF token is kept in memory only (never
// localStorage) and sent on every state-changing request.

export type Role = 'ADMIN' | 'OWNER' | 'VIEWER' | 'EXTERNAL';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });

  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data as { message?: string } | null)?.message ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
};
