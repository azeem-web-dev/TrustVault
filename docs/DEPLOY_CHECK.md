# Deployment check

Copy-paste checks against the live site, with the answer to expect. The unauthenticated ones below were run on 2026-11-08 and the output shown is what came back (request ids shortened). Nothing here signs in or changes anything.

```bash
U=https://vault.rayyanazeem.cloud
```

## 1. Transport and security headers

```bash
curl -sSI http://vault.rayyanazeem.cloud/ | grep -iE '^HTTP|^location'
```
```
HTTP/1.1 301 Moved Permanently
Location: https://vault.rayyanazeem.cloud/
```

```bash
curl -sSI $U/ | grep -iE 'strict-transport|content-security|x-frame|x-content-type|referrer-policy|permissions-policy|cross-origin|cache-control'
```
```
cache-control: no-store
content-security-policy: default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'nonce-…'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
cross-origin-opener-policy: same-origin
permissions-policy: camera=(), microphone=(), geolocation=(), payment=()
referrer-policy: no-referrer
x-content-type-options: nosniff
x-frame-options: DENY
Strict-Transport-Security: max-age=63072000; includeSubDomains
```
The nonce changes on every request. Tested in CI by `e2e/web-security.e2e.ts` and `web-security.test.ts` (THREATS.md W1–W7).

## 2. Health

```bash
curl -sS $U/api/health
```
```
{"ok":true}
```

## 3. Without a session: 401, JSON, never cached

```bash
curl -sS -i $U/api/documents | grep -iE '^HTTP|^cache-control|^\{'
curl -sS -i $U/api/documents/00000000-0000-4000-8000-000000000000 | grep -iE '^HTTP|^\{'
curl -sS -i $U/api/admin/audit | grep -iE '^HTTP|^\{'
```
```
HTTP/1.1 401 Unauthorized
Cache-Control: no-store
{"message":"Sign in required","code":"session_required","requestId":"…"}
```
(the same 401 for all three: without a session nothing tells a document id that exists from one that does not).

## 4. Cross-site requests: refused, and no CORS

```bash
curl -sS -i -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
  --data '{"email":"nobody@example.com","password":"x"}' $U/api/auth/login | grep -iE '^HTTP|^access-control|^\{'
```
```
HTTP/1.1 403 Forbidden
{"message":"Cross-origin request refused","requestId":"…"}
```

```bash
curl -sS -i -H 'Origin: https://evil.example' $U/api/documents | grep -iE '^HTTP|^access-control'
curl -sS -i -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' $U/api/documents | grep -iE '^HTTP|^access-control'
```
```
HTTP/1.1 401 Unauthorized
HTTP/1.1 404 Not Found
```
No `Access-Control-Allow-Origin` line in either: CORS is never enabled (THREATS.md I4; `probes.test.ts`).

## 5. Unknown routes do not echo the request

```bash
curl -sS -i "$U/api/%3Cscript%3Enope" | grep -iE '^HTTP|^\{'
```
```
HTTP/1.1 404 Not Found
{"message":"Not found","requestId":"…"}
```

## 6. Public audit checkpoints (no sign-in, by design)

```bash
curl -sS "$U/api/witness/checkpoints" | head -c 300
```
Starts with `{"format":"trustvault-witness-v1","signingKey":{"keyId":"keyd-ed25519-v1","publicKey":"OMFkgIVZnsaXmuQkQv/Ibi8oEEEXveEbML5CtjdH+VE="…`. Only signed hashes, no event contents (THREATS.md I9).

## 7. With a session: 403 and 404 (sign in yourself; not run by me)

These need a demo login, so they were not run against the live site for this document; the expected answers are what the CI tests assert. Sign in as Victor in a browser, copy the `__Host-tv_session` cookie value and the CSRF token from the sign-in response, then:

```bash
C='__Host-tv_session=<value>'
# A document Victor was not given (Salary bands 2026): 404, the same as a random id.
curl -sS -i -H "Cookie: $C" $U/api/documents/<salary-bands-id> | grep -iE '^HTTP|^\{'
#   HTTP/1.1 404 Not Found   {"message":"Document not found",…}      (documents.test.ts)
# An admin-only route as a viewer: 403.
curl -sS -i -H "Cookie: $C" $U/api/admin/audit | grep -iE '^HTTP'
#   HTTP/1.1 403 Forbidden                                            (admin-mfa.test.ts)
# A write without the CSRF token: 403.
curl -sS -i -X POST -H "Cookie: $C" -H "Origin: $U" $U/api/folders -H 'Content-Type: application/json' --data '{"name":"x"}' | grep -iE '^HTTP'
#   HTTP/1.1 403 Forbidden                                            (auth.test.ts)
```
Each refusal on a document appears as a `DENIED` row in the owner's History and in the admin audit log.
