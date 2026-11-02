# TrustVault API

Base URL: `https://vault.rayyanazeem.cloud/api`. JSON in and out, except uploads (multipart) and downloads (file bytes).

## Rules that apply to every endpoint

| Rule | Detail |
|---|---|
| **Signed in** | Every endpoint needs the session cookie `__Host-tv_session` unless it is marked *public*. A route with no marking is protected by default. |
| **Second factor** | Every ADMIN, and anyone who has enrolled a TOTP app or passkey, must pass the second step before any endpoint except those marked *partial*. Otherwise: `403 {"code":"mfa_required"}` (or `"mfa_enrolment_required"`). |
| **CSRF** | `POST`, `PUT`, `PATCH`, `DELETE` need header `X-CSRF-Token` with the token from `/auth/login`, `/auth/me` or an MFA step. |
| **Origin** | If the browser sends `Origin`, it must be the site's own origin, otherwise `403`. |
| **Document access** | Every route under `/documents/:id` is decided by `decide()` (`apps/api/src/documents/access.ts`), then again by Postgres row-level security. A refusal is always `404 Document not found`, the same as a document that does not exist, and is written to the audit log with the reason. Any other refused request on `/documents/:id` from a signed-in caller (rate limit, invalid body or parameter, file too large, malformed id) that is not already in the log is recorded as `document.request_refused`. |
| **Ended sessions** | A cookie for a session that was ended (logout, password change, role change, deactivation, admin reset) is refused, and the first use is recorded once as `auth.session_rejected` with why it ended. |
| **Unknown fields** | Request bodies are strict: an unexpected field (`ownerId`, `role`, ...) is `400`. |
| **Errors** | `{"message": "...", "requestId": "..."}`. Unexpected errors are `500` with no details. |
| **Rate limits** | Sign-in: 20/15 min per IP, 10/15 min per account, plus nginx 10/min per IP. Codes and passkey attempts: 5 per 5 min. Uploads: 60/10 min per user. Downloads: 300/10 min per user. Witness: 60/min per IP. `429` with `retryAfterSeconds`. |
| **Uploads** | Every file is scanned by ClamAV before it is stored. Infected: `422`. Scanner unavailable: `503` and nothing is stored. Both are audited. |

Levels: **READ** < **EDIT** < **MANAGE** < **owner**. Account roles: **ADMIN**, **OWNER** (may upload), **VIEWER**, **EXTERNAL** (read-only, must have an expiry, no groups, no directory).

## Authentication

| Method | Path | Who may call | Notes |
|---|---|---|---|
| POST | `/auth/login` | **public** | `{email, password}` → sets cookie, returns `{user, csrfToken, mfaRequired, mfaEnrolled, mfaMethods}`. Same `401` message for every failure, and every failure takes at least 450 ms, so neither reveals whether the email has an account. |
| POST | `/auth/logout` | signed in (*partial*) | Ends this session. |
| GET | `/auth/me` | signed in (*partial*) | Own profile, CSRF token, MFA state. |
| POST | `/auth/password` | signed in | `{currentPassword, newPassword}` (12+ chars). Ends **all** your sessions. Refused for demo accounts. |
| POST | `/auth/password/forgot` | **public** | `{email}`. Always `202 {ok:true}`, whether or not the email has an account, so it reveals nothing. If the account is active, not expired and not a demo account, emails a reset link that works once and expires in 30 minutes; a new link cancels earlier ones. `429` after 10 requests per 15 minutes from one IP. Per address, after 3 an hour it quietly stops sending and still answers `202`. Audited as `auth.reset_requested`. |
| POST | `/auth/password/reset` | **public**: anyone holding a valid, unused, unexpired link | `{token, newPassword}` (token from the link's `#token=` fragment). `204`: password set, every session ended, lockout cleared, the cookie cleared, a notice emailed. A second factor is not removed. `400` "This link is invalid or has expired" for a used, expired, cancelled, unknown or malformed link, or a demo or inactive account; `400` for a weak password. Audited as `auth.password_reset_link`, allowed or refused. |
| POST | `/auth/invite/check` | **public**: anyone holding a valid invitation link | `{token}` → `{email, role, accessExpiresAt}`, so the page can say who is joining. `400` (same message as accept) for any link that cannot be accepted; refusals audited as `auth.invite_check`. |
| POST | `/auth/invite/accept` | **public**: anyone holding a valid, unused, unexpired invitation link | `{token, displayName, password}` (12+ chars). `204`: name and password set, account `ACTIVE`, a welcome email sent; the person then signs in (admins enrol a second factor first). `400` "This invitation link is invalid or has expired" for a used, expired, cancelled, unknown, malformed or reset link, or an account no longer waiting; `400` for a weak password or empty name. Check and accept share 20 per 15 minutes per IP. Audited as `auth.invite_accepted`. |
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
| GET | `/witness/checkpoints` | **public** | `since` (seq, default 1), `limit` (1 to 1000). Signed audit checkpoints `{seq, headHash, signature, keyId, createdAt}`, the signing public key, and `eventHashAtSince` (the chain's current hash at `since`). No event content. Used by the outside witness (`tools/witness.mjs`). |

## Documents

| Method | Path | Who may call | Notes |
|---|---|---|---|
| GET | `/documents` | signed in | Search: `q`, `owner`, `category`, `from`, `to`, `scope=all\|mine\|shared\|trash`, `folderId`, `page`. Only documents you own or hold a live grant on; counts come from the same filtered set. |
| GET | `/documents/categories` | signed in | Categories of documents you can see. |
| POST | `/documents` | role **OWNER** | Multipart: `file`, `title`, `category`, `description?`, `folderId?`. Max 25 MB. Type decided from content (PDF without JavaScript, PNG, JPEG, docx/xlsx/pptx without macros, UTF-8 text/CSV/Markdown). Malware-scanned (`422` / `503`). |
| GET | `/documents/:id` | **READ+** | Metadata, versions, your level. |
| PATCH | `/documents/:id` | **EDIT+** for `title`, `category`, `description`; **owner** for `folderId` | |
| POST | `/documents/:id/versions` | **EDIT+** | Multipart `file`. Scanned only after the permission check. |
| GET | `/documents/:id/download` | **READ+** | Current version. Audited **before** the first byte is sent. `Content-Disposition: attachment`, `CSP: sandbox`, `nosniff`, `no-store`, `X-Document-SHA256`. |
| GET | `/documents/:id/versions/:n/download` | **READ+** | A specific version. Either download answers `403` (audited) for a version the nightly malware re-scan quarantined; `GET /documents/:id` shows `quarantine: {signature, foundAt}` on such a version. |
| GET | `/documents/:id/history` | **MANAGE+** | Audit events for this document, including refusals and break-glass use. |
| POST | `/documents/:id/trash` | **owner** | Hidden from everyone else at once. |
| POST | `/documents/:id/restore` | **owner** | |
| DELETE | `/documents/:id` | **owner**, document in trash | Permanent. The audit trail stays. |
| POST | `/documents/:id/transfer` | **owner** | `{newOwnerId}` must be an active OWNER. `200 {stillHas}`: the level the former owner keeps through a group grant, or `null`. They keep nothing of their own. |

## Sharing

| Method | Path | Who may call | Notes |
|---|---|---|---|
| GET | `/documents/:id/access` | **MANAGE+** | Owner and every grant. A group row has `members` (in the group now), `covered` (members the share reaches) and `pending` (added since the share; they cannot open the document until it is confirmed). |
| PUT | `/documents/:id/access` | **MANAGE+**; granting or changing **MANAGE** needs **owner** | `{userId \| groupId, level, expiresAt?, fromSuggestion?}`. Creates or changes a grant. Externals: READ only, expiry required, capped at their account expiry. Admins cannot be given access (`400`). You cannot change your own access. A group share covers the group's members at that moment (never admins or externals); sending the same group share again confirms members added since. Only the owner may share with a group the sharer belongs to (`403`). |
| DELETE | `/documents/:id/access/:grantId` | **MANAGE+**; removing a **MANAGE** grant needs **owner** (or yourself) | Takes effect on the next request. `200 {stillHas}`: for a person's grant, the level a group grant still gives them, or `null`; always `null` for a group grant. |
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
| POST | `/admin/users` | **Invite** `{email, role, accessExpiresAt?}` (`accessExpiresAt` required for EXTERNAL). No password or name: the account starts `INVITED` and the person chooses both from an emailed link that works once and expires after `INVITE_LINK_HOURS` (72). `201 {user, invited}`; `invited` is `false` when mail is off (send again later). `409` if the email exists. Audited as `user.create` and `user.invite` (THREATS.md S18). |
| POST | `/admin/users/:id/invite` | Emails the invitation again; earlier links stop working. `202 {ok:true, sent}`. `400` unless the account is `INVITED`. |
| PATCH | `/admin/users/:id` | `{displayName?, role?, accessExpiresAt?}`. A role change or a changed `accessExpiresAt` ends that user's sessions. Leaving OWNER is refused while the person owns documents (`400`). Becoming ADMIN or EXTERNAL drops their grants and group memberships. Leaving ADMIN ends any open break-glass window. Not your own role; never the last active admin; never a demo account. |
| POST | `/admin/users/:id/deactivate` | Ends their sessions, any open break-glass window and any unused invitation or reset link in the same transaction. Also how an invitation is cancelled. Not yourself; never the last active admin; never a demo account. |
| POST | `/admin/users/:id/reactivate` | Back to `ACTIVE`, or to `INVITED` if they never accepted their invitation (nobody knows their password). |
| POST | `/admin/users/:id/password` | `{password}`. `400` for an invited account. Ends their sessions and emails them a notice. Kept in the API, but the website and app no longer use it: the admin would know the password (THREATS.md S15). |
| POST | `/admin/users/:id/reset-link` | Emails the person a reset link. `202 {ok:true, sent}`. The admin never gets the link or sees the new password. `sent` is `false` for a demo account or when mail is off. `404` unknown user; `400` if the account is not active. Audited as `user.reset_link_sent`. |
| POST | `/admin/users/:id/mfa/reset` | Removes their TOTP and passkeys; ends their sessions. Not yourself. |
| GET / POST | `/admin/groups` | List with members; create. |
| PATCH / DELETE | `/admin/groups/:id` | Deleting a group removes its document grants in the same transaction. |
| POST | `/admin/groups/:id/members` | `{userId}`. Not EXTERNAL or ADMIN accounts (`400`). A new member reaches the group's documents only after each document's owner confirms (see `PUT /documents/:id/access`). |
| DELETE | `/admin/groups/:id/members/:userId` | Access through the group ends on the member's next request. |
| GET | `/admin/audit` | `action` (prefix), `outcome`, `actor`, `documentId`, `from`, `to`, `before`, `limit`. Newest first, with document titles (never contents). |
| POST | `/admin/audit/verify` | Recomputes every hash and checks every signed checkpoint. |
| POST | `/admin/audit/checkpoint` | Signs the current chain head now (also every minute when there are new events; each checkpoint is then published to Sigstore's public log). |
| GET | `/admin/audit/export` | `fromSeq`, `toSeq`: evidence bundle for `tools/verify-audit.mjs`. The bundle's `verifyWith` field gives the command: `node tools/verify-audit.mjs <bundle.json> --key <production public key> --rekor --witness <witness branch>/checkpoints.jsonl`. With none of `--key`, `--rekor` or `--witness` the tool exits 2: the bundle is only shown to be internally consistent. |
| GET | `/admin/alerts` | `hours` (1 to 720, default 24). Kinds: `audit_verification_failed`, `file_integrity`, `malware_found` (critical); `rescan_failed`, `reset_then_sign_in` (an account signed in after an admin reset its password or second factor), `ended_session_used`, `access_after_revoke`, `repeated_denials` (high); `bulk_download`, `break_glass` (medium); `external_share`, `login_blocked` (info). |
| POST | `/admin/break-glass` | `{documentId, reason}` (20+ chars): one hour of READ on one document. Audited, alerted, visible in the document's history. |

## Emails

Mail is sent after the change it reports is committed. It never delays or fails the request. **Demo accounts never get mail**: their addresses belong to someone else. Production sends through Hostinger SMTP from `updates@rayyanazeem.cloud`. With `MAIL_TRANSPORT=off` nothing is sent and no reset link is created (the forgot endpoint still answers `202`).

| Event | Who gets it |
|---|---|
| Reset link asked for (`/auth/password/forgot`) or sent by an admin | The account holder: the link |
| Invitation (new account, or sent again) | The invited address: the link, the role, and the access end date if any |
| Invitation accepted | The new account holder: a welcome with a sign-in link |
| Password changed (own settings, reset link, or an admin) | The account holder |
| Sign-in (after the second step, if there is one) | The account holder, with time, IP and device, and a link to reset |
| Authenticator app added, passkey added or removed, second factor reset by an admin | The account holder |
| A document newly shared with a person | That person only: document title, sharer, level, expiry. Never contents. Group shares send no email |

## Audit actions for password reset and invitations

| Action | Outcome and reason |
|---|---|
| `auth.reset_requested` | One per request that passes the IP limit. `ALLOWED` with reason `sent`; otherwise `DENIED` with `no_account`, `not_eligible` (inactive, expired or demo account), `rate_limited` (per-address limit) or `mail_off` |
| `auth.password_reset_link` | A link used. `ALLOWED` with the number of sessions ended; or `DENIED` with `malformed_link`, `unknown_link`, `wrong_link_type` (an invitation link), `link_used`, `link_expired` or `not_eligible` |
| `user.reset_link_sent` | An admin sent a link. `ALLOWED`; or `DENIED` with `demo_account` or `mail_off` |
| `user.invite` | An admin invited someone or sent the invitation again (`details.again`). `ALLOWED`; or `DENIED` with `mail_off` |
| `auth.invite_accepted` | An invitation link used. `ALLOWED`; or `DENIED` with `malformed_link`, `unknown_link`, `wrong_link_type` (a reset link), `link_used`, `link_expired` or `not_eligible` |
| `auth.invite_check` | Only refusals, with the same reasons |
