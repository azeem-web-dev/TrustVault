// Thin client for the TrustVault API. The session lives in an HttpOnly
// cookie the page cannot read; the CSRF token is kept in memory only (never
// localStorage) and sent on every state-changing request.

export type Role = 'ADMIN' | 'OWNER' | 'VIEWER' | 'EXTERNAL';
export type Level = 'VIEW' | 'READ' | 'EDIT' | 'MANAGE';
export type Access = Level | 'OWNER' | 'NONE';

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
    readonly body: { code?: string; issues?: { path: string; message: string }[] } | null,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
let onMfaRequired: (() => void) | null = null;
let onStepUp: (() => Promise<boolean>) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when the API says the session still owes a second factor. */
export function setMfaHandler(fn: (() => void) | null): void {
  onMfaRequired = fn;
}

/**
 * Called when the API wants a fresh second factor before a risky action
 * (403 step_up_required). Resolves true once the user has confirmed, and the
 * original request is then sent again, once.
 */
export function setStepUpHandler(fn: (() => Promise<boolean>) | null): void {
  onStepUp = fn;
}

async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const headers: Record<string, string> = {};
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as (T & { message?: string; code?: string; csrfToken?: string }) | null;
  if (!res.ok) {
    if (res.status === 403 && data?.code === 'step_up_required' && !retried && onStepUp && (await onStepUp())) {
      return call<T>(method, path, body, true);
    }
    if (res.status === 403 && (data?.code === 'mfa_required' || data?.code === 'mfa_enrolment_required')) onMfaRequired?.();
    const issues = (data as { issues?: { message: string }[] } | null)?.issues;
    const message = issues?.length ? issues.map((i) => i.message).join('; ') : (data?.message ?? `Request failed (${res.status})`);
    throw new ApiError(res.status, message, data as ApiError['body']);
  }
  // Sign-in steps that rotate the session also rotate the CSRF token.
  if (data && typeof data === 'object' && typeof data.csrfToken === 'string') csrfToken = data.csrfToken;
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
  delete: <T>(path: string) => call<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => call<T>('POST', path, form),
};

/**
 * Fire-and-forget POST that survives the page closing (keepalive). Never
 * throws and never tells the user anything: used for silent reports such as
 * a detected screen-capture attempt.
 */
export function beacon(path: string, body: unknown): void {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    void fetch(`/api${path}`, {
      method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin', cache: 'no-store', keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Nothing to do: the report is best effort.
  }
}

export const errorText =(err: unknown, fallback = 'Something went wrong'): string =>
  err instanceof ApiError ? err.message : err instanceof Error && err.name === 'NotAllowedError' ? 'Cancelled' : fallback;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
