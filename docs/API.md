# TrustVault API

Base URL: `https://vault.rayyanazeem.cloud/api`. JSON in and out, except uploads (multipart) and downloads (file bytes).

## Rules that apply to every endpoint

| Rule | Detail |
|---|---|
| **Signed in** | Every endpoint needs the session cookie `__Host-tv_session` unless it is marked *public*. A route with no marking is protected by default. |
| **Second factor** | Every ADMIN, and anyone who has enrolled a TOTP app or passkey, must pass the second step before any endpoint except those marked *partial*. Otherwise: `403 {"code":"mfa_required"}` (or `"mfa_enrolment_required"`). |
| **CSRF** | `POST`, `PUT`, `PATCH`, `DELETE` need header `X-CSRF-Token` with the token from `/auth/login`, `/auth/me` or an MFA step. |
| **Origin** | If the browser sends `Origin`, it must be the site's own origin, otherwise `403`. |
| **Document access** | Every route under `/documents/:id` is decided by `decide()` (`apps/api/src/documents/access.ts`), then again by Postgres row-level security. A refusal is always `404 Document not found`, the same as a document that does not exist, and is written to the audit log with the reason. |
| **Unknown fields** | Request bodies are strict: an unexpected field (`ownerId`, `role`, ...) is `400`. |
| **Errors** | `{"message": "...", "requestId": "..."}`. Unexpected errors are `500` with no details. |
| **Rate limits** | Sign-in: 20/15 min per IP, 10/15 min per account, plus nginx 10/min per IP. Codes: 5 per 5 min. Uploads: 60/10 min per user. Downloads: 300/10 min per user. `429` with `retryAfterSeconds`. |

Levels: **READ** < **EDIT** < **MANAGE** < **owner**. Account roles: **ADMIN**, **OWNER** (may upload), **VIEWER**, **EXTERNAL** (read-only, must have an expiry, no groups, no directory).

## Authentication

| Method | Path | Who may call | Notes |
|---|---|---|---|
| POST | `/auth/login` | **public** | `{email, password}` → sets cookie, returns `{user, csrfToken, mfaRequired, mfaEnrolled, mfaMethods}`. Same `401` message for every failure. |
| POST | `/auth/logout` | signed in (*partial*) | Ends this session. |
| GET | `/auth/me` | signed in (*partial*) | Own profile, CSRF token, MFA state. |
| POST | `/auth/password` | signed in | `{currentPassword, newPassword}` (12+ chars). Ends **all** your sessions. Refused for demo accounts. |
| GET | `/auth/mfa` | signed in (*partial*) | Second-factor status and your passkeys. |
| POST | `/auth/mfa/totp/setup` | signed in (*partial*) | Starts TOTP enrolment, returns secret and `otpauth://` URI. If you already have a factor, you must have used it this session. |
| POST | `/auth/mfa/totp/enable` | signed in (*partial*) | `{code}` confirms enrolment. Issues a new session token. |
| POST | `/auth/mfa/totp/verify` | signed in (*partial*) | `{code}` second sign-in step. A code works once. Issues a new session token. |
| POST | `/auth/mfa/passkeys/register/options` | signed in (*partial*) | WebAuthn registration options. |
| POST | `/auth/mfa/passkeys/register` | signed in (*partial*) | `{response, name}`. |
| POST | `/auth/mfa/passkeys/options` | signed in (*partial*) | WebAuthn authentication options. |
| POST | `/auth/mfa/passkeys/verify` | signed in (*partial*) | `{response}` second sign-in step. Issues a new session token. |
| DELETE | `/auth/mfa/passkeys/:id` | signed in, MFA passed | Admins cannot remove their last factor. |
| GET | `/health` | **public** | `{ok:true}` only. |

## Documents

| Method | Path | Who may call | Notes |
|---|---|---|---|
| GET | `/documents` | signed in | Search: `q`, `owner`, `category`, `from`, `to`, `scope=all\|mine\|shared\|trash`, `folderId`, `page`. Only documents you own or hold a live grant on; counts come from the same filtered set. |
| GET | `/documents/categories` | signed in | Categories of documents you can see. |
| POST | `/documents` | role **OWNER** | Multipart: `file`, `title`, `category`, `description?`, `folderId?`. Max 25 MB. Type decided from content (PDF without JavaScript, PNG, JPEG, docx/xlsx/pptx without macros, UTF-8 text/CSV/Markdown). |
| GET | `/documents/:id` | **READ+** | Metadata, versions, your level. |
| PATCH | `/documents/:id` | **EDIT+** for `title`, `category`, `description`; **owner** for `folderId` | |
| POST | `/documents/:id/versions` | **EDIT+** | Multipart `file`. |
| GET | `/documents/:id/download` | **READ+** | Current version. Audited **before** the first byte is sent. `Content-Disposition: attachment`, `CSP: sandbox`, `nosniff`, `no-store`, `X-Document-SHA256`. |
| GET | `/documents/:id/versions/:n/download` | **READ+** | A specific version. |
| GET | `/documents/:id/history` | **MANAGE+** | Audit events for this document, including refusals and break-glass use. |
| POST | `/documents/:id/trash` | **owner** | Hidden from everyone else at once. |
| POST | `/documents/:id/restore` | **owner** | |
| DELETE | `/documents/:id` | **owner**, document in trash | Permanent. The audit trail stays. |
| POST | `/documents/:id/transfer` | **owner** | `{newOwnerId}` must be an active OWNER. The previous owner keeps no access. |

## Sharing

| Method | Path | Who may call | Notes |
|---|---|---|---|
| GET | `/documents/:id/access` | **MANAGE+** | Owner and every grant. |
| PUT | `/documents/:id/access` | **MANAGE+**; granting or changing **MANAGE** needs **owner** | `{userId \| groupId, level, expiresAt?, fromSuggestion?}`. Creates or changes a grant. Externals: READ only, expiry required, capped at their account expiry. You cannot change your own access. |
| DELETE | `/documents/:id/access/:grantId` | **MANAGE+**; removing a **MANAGE** grant needs **owner** (or yourself) | Takes effect on the next request. |
| GET | `/documents/:id/suggestions` | **MANAGE+** | People and groups you shared similar documents with. Grants nothing; the suggestion is audited. |
| GET | `/directory?q=` | roles **ADMIN, OWNER, VIEWER** | People picker: at most 10 active users and 5 groups matching 2+ characters. Not available to EXTERNAL. |

## Folders

| Method | Path | Who may call | Notes |
|---|---|---|---|
| GET / POST | `/folders` | role **OWNER** (own folders only) | Folders organise; they never grant access. |
| PATCH / DELETE | `/folders/:id` | role **OWNER**, folder owner | Deleting a folder never deletes documents. |

## Administration (role ADMIN, second factor passed)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/users` | All accounts. |
| POST | `/admin/users` | `{email, displayName, role, password, accessExpiresAt?}` (required for EXTERNAL). |
| PATCH | `/admin/users/:id` | `{displayName?, role?, accessExpiresAt?}`. A role change ends that user's sessions. Not yourself; never the last active admin; never a demo account. |
| POST | `/admin/users/:id/deactivate` | Ends their sessions in the same transaction. Same exceptions as above. |
| POST | `/admin/users/:id/reactivate` | |
| POST | `/admin/users/:id/password` | `{password}`. Ends their sessions. |
| POST | `/admin/users/:id/mfa/reset` | Removes their TOTP and passkeys; ends their sessions. Not yourself. |
| GET / POST | `/admin/groups` | List with members; create. |
| PATCH / DELETE | `/admin/groups/:id` | Deleting a group removes its document grants in the same transaction. |
| POST | `/admin/groups/:id/members` | `{userId}`. Not EXTERNAL accounts. |
| DELETE | `/admin/groups/:id/members/:userId` | Access through the group ends on the member's next request. |
| GET | `/admin/audit` | `action` (prefix), `outcome`, `actor`, `documentId`, `from`, `to`, `before`, `limit`. Newest first, with document titles (never contents). |
| POST | `/admin/audit/verify` | Recomputes every hash and checks every signed checkpoint. |
| POST | `/admin/audit/checkpoint` | Signs the current chain head now (also every 10 minutes). |
| GET | `/admin/audit/export` | `fromSeq`, `toSeq`: evidence bundle for `node tools/verify-audit.mjs`. |
| GET | `/admin/alerts` | `hours` (1 to 720). |
| POST | `/admin/break-glass` | `{documentId, reason}` (20+ chars): one hour of READ on one document. Audited, alerted, visible in the document's history. |
