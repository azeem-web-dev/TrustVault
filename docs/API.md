# TrustVault API

Base URL: `https://vault.rayyanazeem.cloud/api`. JSON in and out, except uploads (multipart) and downloads (file bytes).

## Rules that apply to every endpoint

| Rule | Detail |
|---|---|
| **Signed in** | Every endpoint needs the session cookie `__Host-tv_session` unless it is marked *public*. A route with no marking is protected by default. |
| **Second factor** | Every ADMIN, every role an admin added to the MFA policy (`/admin/settings/mfa-policy`), and anyone who has enrolled a TOTP app or passkey, must pass the second step before any endpoint except those marked *partial*. Otherwise: `403 {"code":"mfa_required"}` (or `"mfa_enrolment_required"`). The policy is read on every request, so a change applies to sessions that are already open. |
| **Step-up** | Endpoints marked **step-up** also need the second factor to have been presented in this session within `STEP_UP_MINUTES` (default 5). Otherwise `403 {"code":"step_up_required"}`, audited as `security.step_up_required`; the client calls `POST /auth/mfa/step-up` and sends the request again. Accounts that need no second factor are not asked. |
| **CSRF** | `POST`, `PUT`, `PATCH`, `DELETE` need header `X-CSRF-Token` with the token from `/auth/login`, `/auth/me` or an MFA step. |
| **Origin** | If the browser sends `Origin`, it must be the site's own origin, otherwise `403`. |
| **Document access** | Every route under `/documents/:id` is decided by `decide()` (`apps/api/src/documents/access.ts`), then again by Postgres row-level security. A refusal is always `404 Document not found`, the same as a document that does not exist, and is written to the audit log with the reason. Any other refused request on `/documents/:id` from a signed-in caller (rate limit, invalid body or parameter, file too large, malformed id) that is not already in the log is recorded as `document.request_refused`. |
| **Order with revokes** | A request on a document and any change to who may reach it happen one after the other, never interleaved. Reading (`GET /documents/:id`, downloads) takes the document's lock and the caller's lock **shared**; every change that gives or takes away access (grant, change or revoke, group membership, coverage confirmation, transfer, trash, restore, purge, role, status, end date or password change, break-glass) takes the matching lock **exclusive** until it commits. **A request whose decision happens after the revoke commits is denied; an already-authorized transfer completes and is recorded before the revoke.** The decision, the version fetch and the `ALLOWED` audit row happen under the lock; the bytes are decrypted and sent after the commit, so a download recorded before the revoke may still be streaming when the revoke commits (THREATS.md R6). Expiry has no committer: the database re-checks access as it writes the `ALLOWED` row, so every such row is dated before the grant or account expired; a download whose access lapsed mid-request is refused as `access_ended_during_request`. A session ended while the request waited (password reset, deactivation) is refused as `session_ended`. Downloads still run in parallel with each other. |
| **Ended sessions** | A cookie for a session that was ended (logout, password change, role change, deactivation, admin reset) is refused, and the first use is recorded once as `auth.session_rejected` with why it ended. |
| **Database rules on accounts** | Besides the API's checks, the database itself refuses account changes from the app's database role unless an active admin's request makes them (role, status, end date, names, groups), the person themselves does (password, their own second factor), or a link used in the same request does (reset, invitation). An admin never sets a password, never changes their own role or status, and the last active admin cannot be removed. Password hashes and TOTP secrets cannot be read by that role (THREATS.md A23-A26). |
| **Unknown fields** | Request bodies are strict: an unexpected field (`ownerId`, `role`, ...) is `400`. |
| **Errors** | `{"message": "...", "requestId": "..."}`. Unexpected errors are `500` with no details. |
| **Rate limits** | Sign-in: 20/15 min per IP, 10/15 min per account, plus nginx 10/min per IP. Codes and passkey attempts: 5 per 5 min. Uploads: 60/10 min per user. Downloads: 300/10 min per user. View-only pages: `PAGE_VIEW_RATE_LIMIT` (default 600)/10 min per user. Capture reports: 20/10 min per user. Witness: 60/min per IP. `429` with `retryAfterSeconds`. |
| **Uploads** | Every file is scanned by ClamAV before it is stored. Infected: `422`. Scanner unavailable: `503` and nothing is stored. Every PDF is stored as a **sanitized copy** rebuilt without active content (THREATS.md C9-C11); the answer says what was removed. **Every refused upload or new version is audited** (`document.upload` / `document.upload_version`, `DENIED` or `FAILED`), whatever refused it: see below. |

Levels: **VIEW** < **READ** < **EDIT** < **MANAGE** < **owner**. VIEW sees metadata, versions and watermarked page images, never the original file; READ adds downloading. Account roles: **ADMIN**, **OWNER** (may upload), **VIEWER**, **EXTERNAL** (VIEW or READ only, must have an expiry, no groups, no directory).

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
| GET | `/auth/mfa` | signed in (*partial*) | Second-factor status (`required`, `requiredByRole`, `satisfied`, `stepUpMinutes`, `stepUpFresh`, `totp`) and your passkeys. |
| POST | `/auth/mfa/totp/setup` | signed in (*partial*) | Starts TOTP enrolment, returns `{secret, otpauthUri}`: base32 secret and `otpauth://totp/TrustVault:<email>?secret=…&issuer=TrustVault&algorithm=SHA1&digits=6&period=30`, the format Google Authenticator reads. Codes are RFC 6238 (tested against the RFC's own vectors); one 30-second step of clock drift is accepted either way. If you already have a factor, you must have used it this session. |
| POST | `/auth/mfa/totp/enable` | signed in (*partial*) | `{code}` confirms enrolment. Issues a new session token. |
| POST | `/auth/mfa/totp/verify` | signed in (*partial*) | `{code}` second sign-in step. A code works once. Issues a new session token. |
| POST | `/auth/mfa/passkeys/register/options` | signed in (*partial*) | WebAuthn registration options. |
| POST | `/auth/mfa/passkeys/register` | signed in (*partial*) | `{response, name}`. |
| POST | `/auth/mfa/passkeys/options` | signed in (*partial*) | WebAuthn authentication options. |
| POST | `/auth/mfa/passkeys/verify` | signed in (*partial*) | `{response}` second sign-in step. Issues a new session token. |
| DELETE | `/auth/mfa/passkeys/:id` | signed in, MFA passed, **step-up** | Admins, and roles in the MFA policy, cannot remove their last factor. |
| DELETE | `/auth/mfa/totp` | signed in, MFA passed, **step-up** | Turns the authenticator app off. Same last-factor rule. Not for demo accounts. Audited `mfa.totp_remove`. |
| POST | `/auth/mfa/step-up` | signed in, MFA passed | `{code}` or `{response}` (a passkey assertion for a challenge from `/auth/mfa/passkeys/options`). Moves this session's "second factor last presented" time to now; the session token and CSRF token stay the same. Same 5-per-5-minutes limit as sign-in codes, and a code works once. Audited `mfa.step_up` (`ALLOWED` with `method`, or `DENIED` with `wrong_code`, `code_replayed`, `verification_failed`). A password-only session gets `403 mfa_required`. |
| GET | `/auth/sessions` | signed in, MFA passed | Your own live sessions: `{id, device, ip, createdAt, lastSeenAt, authLevel, current}`. `device` is a name read from the User-Agent, for display only. |
| DELETE | `/auth/sessions/:id` | signed in, MFA passed, **step-up** | Signs one of your other devices out (`revoked_reason` `signed_out_by_user`). Someone else's session id is `404`, like an unknown one; your current session is `400` (use `/auth/logout`). Audited `auth.session_revoke`. |
| POST | `/auth/sessions/revoke-others` | signed in, MFA passed, **step-up** | Ends every other session of yours. `200 {ended}`. Audited `auth.sessions_revoke_others`. |
| GET | `/health` | **public** | `{ok:true}` only. |
| GET | `/witness/checkpoints` | **public** | `since` (seq, default 1), `limit` (1 to 1000). Signed audit checkpoints `{seq, headHash, signature, keyId, createdAt}`, the signing public key, and `eventHashAtSince` (the chain's current hash at `since`). No event content. Used by the outside witness (`tools/witness.mjs`). |

## Documents

| Method | Path | Who may call | Notes |
|---|---|---|---|
| GET | `/documents` | signed in | Search: `q`, `owner`, `category`, `from`, `to`, `scope=all\|mine\|shared\|trash`, `folderId`, `page`. Only documents you own or hold a live grant on; counts come from the same filtered set. |
| GET | `/documents/categories` | signed in | Categories of documents you can see. |
| POST | `/documents` | role **OWNER** | Multipart: `file`, `title`, `category`, `description?`, `folderId?`. Max 25 MB. Type decided from content (PDF, PNG, JPEG, docx/xlsx/pptx without macros, UTF-8 text/CSV/Markdown). `201 {id, sanitized}`: for a PDF `sanitized` is `{removed: string[]}` (empty when there was nothing to remove), for any other type `null`. A PDF is never stored as sent: it is rebuilt without JavaScript, actions, attachments, multimedia, forms and non-web links, the rebuilt file must pass the full strict check, and only it is encrypted and stored (its SHA-256 is the version's `sha256`; the file name is kept). `removed` uses these labels: `JavaScript`, `OpenAction`, `Automatic actions (AA)`, `Launch action`, `Links to other files (GoToR/GoToE)`, `ImportData action`, `SubmitForm action`, `EmbeddedFiles`, `FileAttachment annotation`, `RichMedia/3D/multimedia`, `XFA form`, `Form fields (AcroForm)`, `Non-web link (URI)`. Malware-scanned (`422` / `503`); a PDF twice, as received and as rebuilt. Refusals: `400 {message, code}` with `code` `no_file`, `empty_file`, `type_not_allowed`, `content_rejected` (damaged, polyglot, macros, encrypted or unreadable PDF...), `sanitize_failed` (the rebuilt PDF did not pass) or `check_failed` (out of time or memory); `413` too large; `429`; `503` checker busy or scanner down. |
| GET | `/documents/:id` | **VIEW+** | Metadata, versions, your level (`myAccess`: `VIEW`, `READ`, `EDIT`, `MANAGE` or `OWNER`). |
| PATCH | `/documents/:id` | **EDIT+** for `title`, `category`, `description`; **owner** for `folderId` | |
| POST | `/documents/:id/versions` | **EDIT+** | Multipart `file`. `201 {versionNo, sanitized}`, same rules and refusals as `POST /documents`. The permission is checked first: someone without EDIT gets `404` (audited by the access check) before the file is checked or scanned. |
| GET | `/documents/:id/download` | **READ+** (VIEW: `404`, audited `needs_read`) | Current version. Audited **before** the first byte is sent, with the level it was decided under (`details.level`) and a trace code. PDFs and PNG/JPEG images are **stamped** on every page with who, when and the trace code; other types are sent unchanged. `Content-Disposition: attachment`, `CSP: sandbox`, `nosniff`, `no-store`, `X-Document-SHA256` (the stored version's hash; a stamped copy differs by design), `X-Stamped: yes\|no`, `X-Trace-Code`. |
| GET | `/documents/:id/versions/:n/download` | **READ+** | A specific version. Either download answers `403` (audited) for a version the nightly malware re-scan quarantined; `GET /documents/:id` shows `quarantine: {signature, foundAt}` on such a version. |
| GET | `/documents/:id/pages` | **VIEW+** | `{versionNo, pages, preview, message}` for the current version. PDF, PNG, JPEG and text files are drawn (at most 500 pages); Word, Excel and PowerPoint answer `preview: false` with "Preview is not available for this file type. Ask the owner for download access." |
| GET | `/documents/:id/pages/:n` | **VIEW+** | Page `n` (from 1) as a PNG drawn by the server, with the viewer's email, the UTC time and a trace code tiled across it. Never the original bytes. Each page is a `document.page_view` audit row `{page, pages, versionNo, trace, at}`, committed before the image is sent. `no-store`, `nosniff`, `CSP: sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `X-Trace-Code`. `404` past the last page, `422` for a type with no preview or a file that cannot be drawn. Rate limited per user. |
| POST | `/documents/:id/offline-key` | **READ+** | `{documentId, key, algorithm: "AES-256-GCM"}`: the 32-byte key (base64) for the Android app's encrypted copy of this document. Same key on every call while access lasts; asked for on every open; refused (`404`) after a revoke, and the key is destroyed when access drops below READ, so a later re-share gets a new one. Audited as `document.offline_key`. |
| POST | `/documents/:id/capture-attempt` | **VIEW+** | `{method: "printscreen" \| "snip_shortcut" \| "mac_shortcut" \| "print_shortcut", page?: 1-500}` (unknown fields `400`). Sent silently by the web viewer when it sees a key press that usually starts a screen capture; it does **not** block the capture (a web page cannot). `204` with no body, always the same for whoever may report. Audited as `document.capture_attempt` (`ALLOWED`, reason = method, details `{method, page, userAgent, access}`; shown in the document's history). Unless the reporter is the owner: one `capture_attempt` alert (medium) per person and document per hour, later attempts attached to it as notes, and with each new alert one email to the owner (never to the viewer, never to demo accounts). No access: the usual `404`. 20 per user per 10 minutes. THREATS.md V11. |
| GET | `/documents/:id/history` | **MANAGE+** | Audit events for this document, including refusals and break-glass use. An accepted upload's `details` carry `sha256` and `sizeBytes` of the stored file and, for a PDF, `sanitized: {originalSha256, originalSizeBytes, sanitizedSha256, sanitizedSizeBytes, removed}`. A refused one (`DENIED`/`FAILED`, `reason` one of the codes above, `too_large`, `invalid_input`, `rate_limited`, `malware_detected`, `malware_scanner_unavailable`, `checker_busy`...) carries `{fileName (200 chars at most), sizeBytes, sha256 of the bytes received (null if none), message}`. At most 200 such rows per person per 10 minutes; the 201st is `refusal_audit_suppressed`. |
| POST | `/documents/:id/trash` | **owner** | Hidden from everyone else at once. |
| POST | `/documents/:id/restore` | **owner** | |
| DELETE | `/documents/:id` | **owner**, document in trash, **step-up** | Permanent. The audit trail stays. |
| POST | `/documents/:id/transfer` | **owner**, **step-up** | `{newOwnerId}` must be an active OWNER. `200 {stillHas}`: the level the former owner keeps through a group grant, or `null`. They keep nothing of their own. |

## Sharing

| Method | Path | Who may call | Notes |
|---|---|---|---|
| GET | `/documents/:id/access` | **MANAGE+** | Owner and every grant. A group row has `members` (in the group now), `covered` (members the share reaches) and `pending` (added since the share; they cannot open the document until it is confirmed). |
| PUT | `/documents/:id/access` | **MANAGE+**; granting or changing **MANAGE** needs **owner** | `{userId \| groupId, level, expiresAt?, fromSuggestion?}`. Creates or changes a grant. `level`: `VIEW`, `READ`, `EDIT` or `MANAGE`. Externals: VIEW or READ only, expiry required, capped at their account expiry. Admins cannot be given access (`400`). You cannot change your own access. A group share covers the group's members at that moment (never admins or externals); sending the same group share again confirms members added since. Only the owner may share with a group the sharer belongs to (`403`). |
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
| POST | `/admin/users` | **Step-up.** **Invite** `{email, role, accessExpiresAt?}` (`accessExpiresAt` required for EXTERNAL). No password or name: the account starts `INVITED` and the person chooses both from an emailed link that works once and expires after `INVITE_LINK_HOURS` (72). `201 {user, invited}`; `invited` is `false` when mail is off (send again later). `409` if the email exists. Audited as `user.create` and `user.invite` (THREATS.md S18). |
| POST | `/admin/users/:id/invite` | **Step-up.** Emails the invitation again; earlier links stop working. `202 {ok:true, sent}`. `400` unless the account is `INVITED`. |
| PATCH | `/admin/users/:id` | `{displayName?, role?, accessExpiresAt?}`. **Step-up** when the body has `role`. A role change or a changed `accessExpiresAt` ends that user's sessions. Leaving OWNER is refused while the person owns documents (`400`). Becoming ADMIN or EXTERNAL drops their grants and group memberships. Leaving ADMIN ends any open break-glass window. Not your own role; never the last active admin; never a demo account. |
| POST | `/admin/users/:id/deactivate` | **Step-up.** Ends their sessions, any open break-glass window and any unused invitation or reset link in the same transaction. Also how an invitation is cancelled. Not yourself; never the last active admin; never a demo account. |
| POST | `/admin/users/:id/reactivate` | Back to `ACTIVE`, or to `INVITED` if they never accepted their invitation (nobody knows their password). |
| POST | `/admin/users/:id/reset-link` | **Step-up.** Emails the person a reset link. `202 {ok:true, sent}`. The admin never gets the link or sees the new password. `sent` is `false` for a demo account or when mail is off. `404` unknown user; `400` if the account is not active. Audited as `user.reset_link_sent`. |
| POST | `/admin/users/:id/mfa/reset` | **Step-up.** `{approvalId?}`. Removes their TOTP and passkeys; ends their sessions; emails them. Not yourself. A VIEWER's or EXTERNAL's needs one admin. An **OWNER's or ADMIN's needs a second admin's approval**: without `approvalId`, `409 {code:"approval_required"}`; with one that is not yours, not approved, rejected, expired, already used or for another person, `403 {code:"approval_not_usable"}` (audited as `admin.approval_used`, DENIED, with the reason). There is no endpoint for an admin to set a password: only `reset-link` (THREATS.md S15). |
| GET | `/admin/settings/mfa-policy` | `{requiredRoles}`: roles that must use a second factor. Always includes `ADMIN`. |
| PUT | `/admin/settings/mfa-policy` | **Step-up.** `{requiredRoles}` from `ADMIN`, `OWNER`, `VIEWER`, `EXTERNAL`; leaving out `ADMIN` is `400` (and a database CHECK refuses it too). Applies on everyone's next request: a password-only session of a newly covered role must enrol; sessions that already passed a second factor stay valid. Audited `settings.mfa_policy` with `{from, to}`. |
| GET / POST | `/admin/groups` | List with members; create. |
| PATCH / DELETE | `/admin/groups/:id` | Deleting a group removes its document grants in the same transaction. |
| POST | `/admin/groups/:id/members` | `{userId}`. Not EXTERNAL or ADMIN accounts (`400`). A new member reaches the group's documents only after each document's owner confirms (see `PUT /documents/:id/access`). |
| DELETE | `/admin/groups/:id/members/:userId` | Access through the group ends on the member's next request. |
| GET | `/admin/audit` | `action` (prefix), `outcome`, `actor`, `documentId`, `from`, `to`, `before`, `limit`. Newest first, with document titles (never contents). |
| POST | `/admin/audit/verify` | Recomputes every hash and checks every signed checkpoint. |
| POST | `/admin/audit/checkpoint` | Signs the current chain head now (also every minute when there are new events; each checkpoint is then published to Sigstore's public log). |
| GET | `/admin/audit/export` | `fromSeq`, `toSeq`: evidence bundle for `tools/verify-audit.mjs`. The bundle's `verifyWith` field gives the command: `node tools/verify-audit.mjs <bundle.json> --key <production public key> --rekor --witness <witness branch>/checkpoints.jsonl`. With none of `--key`, `--rekor` or `--witness` the tool exits 2: the bundle is only shown to be internally consistent. |
| GET | `/admin/alerts` | `hours` (1 to 720, default 24). Kinds: `audit_verification_failed`, `file_integrity`, `malware_found` (critical); `rescan_failed`, `reset_then_sign_in` (an account signed in after an admin reset its password or second factor), `ended_session_used`, `access_after_revoke`, `repeated_denials`, `bulk_page_views` (one person viewed more than `PAGE_VIEW_ALERT_PAGES` pages, default 150, or more than `PAGE_VIEW_ALERT_DOCUMENTS` documents, default 15, within 10 minutes) (high); `bulk_download`, `break_glass` (medium); `external_share`, `login_blocked` (info). |
| GET | `/admin/approvals` | Requests for actions that need two admins, newest first, each with `status` `PENDING`, `APPROVED`, `REJECTED`, `USED` or `EXPIRED`. Open requests past their 24 hours are marked expired here (audited once as `admin.approval_expired`). |
| POST | `/admin/approvals` | **Step-up.** `{action: "MFA_RESET", targetUserId, reason}` (an OWNER or ADMIN) or `{action: "BREAK_GLASS", documentId, reason}`; reason 20 to 500 characters. `201 {approval}`, open for 24 hours. `409 {code:"no_second_admin"}` when there is no other active admin: with one admin these actions are impossible. Audited as `admin.approval_requested`. |
| POST | `/admin/approvals/:id/approve` | **Step-up.** A **different** active admin approves. `409` (`own_request`, `already_answered`, `expired`) otherwise, audited. A break-glass approval emails the document's owner at once. Audited as `admin.approval_approved`. |
| POST | `/admin/approvals/:id/reject` | **Step-up.** A different active admin rejects. Audited as `admin.approval_rejected`. |
| POST | `/admin/break-glass` | **Step-up.** `{documentId, approvalId}`: uses a second admin's approval of **your** request for **this** document, once, within its 24 hours; gives you one hour of **VIEW** on it (its watermarked pages, no download), with the reason given in the request. `403 {code:"approval_not_usable"}` otherwise. Audited (`admin.approval_used`, `admin.break_glass`), alerted, visible in the document's history. |

## View-only pages and leak tracing

Server requirements: none beyond Node. Pages are drawn by pdf.js (`pdfjs-dist`, Apache-2.0) on Skia (`@napi-rs/canvas`, MIT, prebuilt for linux-x64 glibc and musl, no system libraries) and downloads are stamped with `pdf-lib` (MIT). The watermark font is the Liberation Sans that ships inside pdf.js, so no system fonts are needed. Settings (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `PAGE_VIEW_RATE_LIMIT` | 600 | Pages one person may open per 10 minutes (`429` after) |
| `PAGE_VIEW_ALERT_PAGES` | 150 | `bulk_page_views` alert when one person views more pages than this within 10 minutes |
| `PAGE_VIEW_ALERT_DOCUMENTS` | 15 | ... or more documents than this |

| Action | When |
|---|---|
| `document.page_view` | `ALLOWED` per page sent, details `{page, pages, versionNo, trace, at}`; `FAILED` `render_failed` when a file cannot be drawn. To trace a leaked picture, search the audit log for its code |
| `document.capture_attempt` | `ALLOWED` per report from the web viewer of a likely screen capture, reason = method, details `{method, page, userAgent, access}`; `DENIED` like any refused document request. Not proof a picture was taken, nor that none was |
| `document.download` | Now also `{trace, stamp: "pdf" \| "image" \| "none"}` |
| `document.download_stamp` | `FAILED` `stamp_failed`: the copy went out unstamped (e.g. an encrypted PDF), with its trace code |
| `document.offline_key` | The Android app asked for a copy's key: `ALLOWED` `{created}`, or `DENIED` (`needs_read`, `no_grant`, ...) |

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

## Passkeys from the Android app

The app uses Android's Credential Manager. Android reports the origin as `android:apk-key-hash:<base64url SHA-256 of the app's signing certificate>`, so the API accepts the origins listed in `PASSKEY_ANDROID_ORIGINS` (comma separated, checked at startup) as well as `PUBLIC_ORIGIN`. The RP id is always the website's host name, so one passkey works in both. Android only offers it to the app after reading `https://vault.rayyanazeem.cloud/.well-known/assetlinks.json` (served by the web app from `apps/web/public/.well-known/`), which names the package and the release certificate's fingerprint.

## Access policies: download approval, working hours, networks

Conditions an owner can put on a share, and rules administrators can set per role (THREATS.md P1-P15, design in `docs/ACCESS_POLICIES.md`). Both locks enforce them: `decide()` in the API and `tv_doc_level()` / the `blobs_release` row-level security policy in Postgres.

**On a share.** `PUT /documents/:id/access` takes an optional `policy`:

```json
{ "userId": "…", "level": "READ",
  "policy": { "downloadApproval": true, "approverId": "<a manager, optional>",
              "window": { "days": [1,2,3,4,5], "start": "09:00", "end": "18:00", "timeZone": "Europe/London" },
              "networks": ["10.0.0.0/8", "2001:db8::/32"] } }
```

- `days` are ISO (1 Monday … 7 Sunday) of the **local** date; `start` inclusive, `end` exclusive, `24:00` allowed as an end; windows over midnight are refused (use two days). `timeZone` must be a named IANA zone (`UTC+5` style offsets are refused). Daylight-saving changes follow the zone's rules.
- `networks`: up to 32 IPv4/IPv6 CIDR ranges; a bare address is a /32 or /128; a range with host bits set (`10.0.0.1/8`) is refused with the range you probably meant.
- Omitting `policy` when changing an existing share keeps its conditions. Only the owner may change conditions a share already has (`403`); anyone who may share can put conditions on a new share.
- `GET /documents/:id/access` returns each grant's `policy` and, for the owner, the `overrides` in force.

Outside its window or network a share gives nothing. If that leaves the caller with no access, document routes answer `403 {"code":"outside_time_window" | "network_not_allowed", "message": "…"}` (the person holds a share, so they are told why) and the refusal is audited with the client IP. Owners are never limited on their own documents.

**Client IP.** Express derives it from the socket and believes `X-Forwarded-For` only from `TRUSTED_PROXIES` (default `loopback`, i.e. nginx on the same machine, which overwrites the header). It takes the right-most address not set by a trusted proxy. An IP allowlist checks the network, not the device: do not use it as the only control.

| Method | Path | Who may call | Notes |
|---|---|---|---|
| GET | `/documents/:id` | VIEW or better | Now also returns `downloadNeedsApproval` (only meaningful for READ and up: View only never downloads). |
| GET | `/documents/:id/download`, `/documents/:id/versions/:n/download` | READ or better | When downloads need approval: uses one approved download **of that exact version** (oldest-expiring approval first), in the same transaction that reads the bytes. None: `403 {"code":"approval_required","versionNo":n}`, audited `document.download` DENIED `approval_required`. |
| POST | `/documents/:id/download-requests` | READ or better, on a share that needs approval | `{reason (10-500 chars), versionNo?}` (default: current version). `201 {id, status:"PENDING", versionNo}`. `400` if no approval is needed; `409` if you already have a pending request for that version. The owner and any nominated approver are emailed (never demo accounts). 30 per hour per user. |
| GET | `/documents/:id/download-requests` | READ or better (View only cannot ask: it never downloads) | Your own requests on the document (`mine: true`); all of them for the owner or the nominated approver. Expired ones are marked first. |
| GET | `/download-requests` | signed in | Pending requests you may decide: on documents you own, or shares where the owner nominated you (and you still have MANAGE). |
| POST | `/download-requests/:rid/approve` | the owner, or the nominated approver; **never the requester** | `{hours 1-72 (default 24), uses 1-10 (default 1), note?}`. The requester is emailed. `403` for your own request (audited `self_approval`); `404` for a request you cannot see (audited `no_such_request`); `409` if already decided or older than 7 days (then marked expired). |
| POST | `/download-requests/:rid/reject` | same | `{note?}`. Recorded and the requester is told. |
| POST | `/documents/:id/overrides` | owner only, **step-up** | Emergency exception: `{userId, reason (10-500), hours 1-24 (default 4)}`. Lifts the time window, network and download-approval conditions of that person's share on this document until it ends; never raises the level, never lifts role rules. The person is emailed, and the owner gets a receipt. |
| DELETE | `/documents/:id/overrides/:overrideId` | owner only | Ends an exception early. |
| GET | `/admin/access-policies` | ADMIN | Role rules in force. |
| PUT | `/admin/access-policies/:role` | ADMIN, **step-up** | `role` = `OWNER`, `VIEWER` or `EXTERNAL`. `{window?, networks?}` (at least one). Applies on top of every share held by people with that role; an owner's exception does not lift it; owners' own documents are not affected. |
| DELETE | `/admin/access-policies/:role` | ADMIN, **step-up** | Removes the role's rules. |

**Emails.** Download requested → the owner and any nominated approver. Approved / not approved → the requester. Emergency exception → the person, plus a receipt to the owner. Demo accounts never get mail.

**Audit actions.**

| Action | Outcome and reason |
|---|---|
| `download_approval.request` | `ALLOWED`, with `versionNo` and `reason` |
| `download_approval.approve` / `.reject` | `ALLOWED` with the terms (`hours`, `uses`, `validUntil`, `note`); or `DENIED` with `self_approval`, `not_approver`, `no_such_request` or `database_refused` |
| `download_approval.use` | `ALLOWED`, one per download released, with `use` of `of` |
| `download_approval.expire` | `ALLOWED` by `system`: `pending_too_long` (7 days) or `approval_window_ended` (hourly job, and on listing) |
| `document.download` | also `DENIED` `approval_required`; an `ALLOWED` row names the `approvalId` used |
| `document.<action>` | also `DENIED` `outside_time_window` / `network_not_allowed`, with the client `ip` |
| `access.grant` / `access.change` | `details.policy` when conditions were set |
| `access.revoke` | `details.approvalsCancelled`: open requests and approvals of that person cancelled with the share |
| `access.override` / `access.override_end` | `ALLOWED`, with the person, reason and end time |
| `policy.role_set` / `policy.role_clear` | `ALLOWED`, with the new and previous rules |

## Key service: tickets, key-use ledger, reconciliation

See [KEYS.md](KEYS.md). Downloads now obtain a database-issued unwrap ticket inside their audit transaction; nothing changes for clients except two new answers on `GET /api/documents/:id/download` (and `/versions/:n/download`): **429** when keyd's per-user unwrap limit is reached, **503** when keyd refuses or is unreachable. Both are audited as `document.download` with reason `key_service_refused` (`details.refusal`), not as an integrity failure.

| Route | Who | What |
|---|---|---|
| `GET /api/admin/keyd/status` | ADMIN | Current key generation, loaded generations, retired ones, current wrap key ids, ticket key ids keyd holds, ledger head seq, and how many document keys / TOTP secrets use each key id (`wrappedValues`) |
| `GET /api/admin/keyd/ledger?before=&limit=` | ADMIN | keyd's key-use ledger as mirrored by the API, newest first (`n`, `epoch`, `seq`, `at`, `event`, `action`, `tid`, `user_id`, `document_id`, `version_id`, `audit_event_id`, `audit_seq`, `key_id`, `result`, `detail`, `hash`) |
| `POST /api/admin/keyd/reconcile` | ADMIN | Mirror keyd's ledger now and reconcile it with the audit log; returns `{ ok, epoch, ledgerFrom, ledgerTo, auditFrom, auditTo, counts, critical, warnings, findings[], findingsTotal }`. Also runs hourly |
| `GET /api/witness/keyd-ledger?since=&limit=` | anyone (rate-limited per IP) | Signed heads of keyd's ledger: `{ format: 'trustvault-keyd-ledger-v1', signingKey, checkpoints: [{ n, epoch, seq, headHash, signature, keyId, createdAt }], hasMore }`. Signature: Ed25519 over `tv-unwrap-ledger-v1|<seq>|<headHash>`. Anchored to Rekor by `tools/anchor.mjs` |

| Audit action | Outcome and reason |
|---|---|
| `document.rescan_decrypt` | `ALLOWED`, system actor: the nightly re-scan obtained a ticket for one version (`details.versionNo`) |
| `keyd.reconcile` | `ALLOWED` (`clean` or `warnings`) or `FAILED` (`unmatched_key_use`), with counts and the first findings |
| `keyd.ledger` | `FAILED` (`ledger_problem`): the mirrored ledger did not verify, its signing key changed, or keyd started a new ledger |
| `keys.rotate` | `ALLOWED` or `FAILED` (`some_values_failed`), actor `key-rotation`: a `keys.js rotate` run, with counts |
| `keys.reencrypt` | `started`, `finished` or `finished_with_failures` for an emergency re-encryption run (`details.run`) |
| `keys.reencrypt_version` | `ALLOWED`: one version re-encrypted in a run (backs the maintenance ticket) |

Alerts: `GET /api/admin/alerts` adds `key_ledger_mismatch` (critical) for failed reconciliations and ledger problems.

## Alerts, detection thresholds and download limits (role ADMIN, second factor passed)

Alerts are **persistent** (THREATS.md L15-L19): a job evaluates the rules every minute and inserts alerts that are never updated or deleted. Review is a separate, append-only history. `GET /admin/alerts` (above) is kept as the old live view.

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/alert-queue` | `status` (`active` = not resolved, default; `open`, `acknowledged`, `assigned`, `resolved`, `all`), `severity` (comma list), `minSeverity`, `category` (`extraction`, `access`, `auth`, `session`, `integrity`, `policy`, `system`), `rule`, `subject` (email contains), `subjectUserId`, `documentId`, `assignee` (`me` or a user id), `from`, `to`, `sort` (`severity` first, default; or `newest`), `cursor`, `limit` (1-200, default 50). Returns `{alerts, total, bySeverity, nextCursor}`; `total` and `bySeverity` count **every** matching alert, not just the page. |
| GET | `/admin/alert-queue/summary` | Unresolved counts per severity, counts per status, top rules and people, and the generator's health (`lastOkAt`, `lastError`, `stale` after 10 minutes). |
| GET | `/admin/alert-queue/reviewers` | Active admins (for assigning). |
| POST | `/admin/alert-queue/evaluate` | Run the rules now. `{run: {scannedEvents, raised, bySeverity, escalated, backlog}}`, or `{run: null}` if a run is already going. |
| GET | `/admin/alert-queue/:id` | The alert, its full review history and how many other alerts the same person had in 30 days. |
| POST | `/admin/alert-queue/:id/acknowledge` | `{note?}`. Only from `open`. |
| POST | `/admin/alert-queue/:id/assign` | `{assigneeId, note?}`: an active admin, not the person the alert is about. |
| POST | `/admin/alert-queue/:id/resolve` | `{resolution, note}`: `true_positive`, `false_positive`, `benign` or `duplicate`; note 5+ chars. |
| POST | `/admin/alert-queue/:id/reopen` | `{note}`. Only a resolved alert. |
| POST | `/admin/alert-queue/:id/comment` | `{note}`. Status unchanged. |
| GET | `/admin/risk-settings` | Every threshold and hard limit: value, default, allowed range, who changed it last. |
| PUT | `/admin/risk-settings` | **Step-up.** `{values: {key: number}, reason}` (reason 10+ chars). Out-of-range values are `400`. Audited as `alert.policy_change` with before and after; raises an `alert_policy_changed` alert. |
| GET | `/admin/download-limits/overrides` | `userId?`. Newest first, with `active`. |
| POST | `/admin/download-limits/overrides` | **Step-up.** `{userId, dailyLimit, sessionLimit, reason, expiresAt}`: raises one person's limits until `expiresAt` (at most 14 days; reason 20+ chars; not yourself, not an admin). Audited as `download.limit_override`; raises a `download_limit_override` alert. |
| POST | `/admin/download-limits/overrides/:id/revoke` | **Step-up.** `204`. Once. Audited as `download.limit_override_revoke`. |
| GET | `/admin/download-limits/usage/:userId` | Effective limits (with any override) and downloads in the last 24 hours and 7 days. |

A review step that does not fit the current status is `409`; an alert about yourself cannot be resolved or assigned by you (`403`). Every step is audited as `alert.acknowledge`, `alert.assign`, `alert.resolve`, `alert.reopen` or `alert.comment`.

**Rules** (defaults; all adjustable within bounds through `/admin/risk-settings`):

| Rule | Severity | When |
|---|---|---|
| `bulk_download_hour` | medium (high at 3x) | 20+ downloads by one person within an hour |
| `bulk_download_day` / `_week` / `_long` | high | 100+ in 24 h / 300+ in 7 days / 1000+ in 30 days (`long_window_days`) |
| `above_baseline` | medium | 24 h above 5x the person's median day over the previous 30 days (and 30+); needs 5 active days of history |
| `above_peers` | medium | 7 days above 5x the median of active accounts with the same role (and 50+); needs 3 peers |
| `document_coverage` | high | 50% or more of the documents the person can open downloaded within the long window (when they can open 20+) |
| `unusual_hours` | medium | 20+ downloads in 24 h at UTC hours of the day the person never used in 30 days (needs 7 active days) |
| `session_download_volume` | medium | 50+ downloads in one session |
| `session_network_changed` | medium | downloads in one session from two networks |
| `shared_network_extraction` | high | 2+ accounts each with 25+ downloads in 24 h from one network, 100+ together |
| `download_limit_hit` | medium | a hard limit refused someone (one per person, kind and day) |
| `unusual_sign_in` | medium (both new) / low | a device kind or network not used by the account in 90 days; the person is emailed |
| `concurrent_sessions` | medium (same device kind) / low | the account live from two networks at once |
| `alert_flood`, `alert_flood_document`, `alert_flood_global` | high | 10+ alerts about one person or document in 24 h; 50+ alerts in an hour |
| `alert_policy_changed`, `download_limit_override` | medium | thresholds changed; a limit raised for someone |
| `capture_attempt` | medium | the web viewer reported a likely screen capture of a document (one per person and document per hour, later attempts attached as notes; raised by the request, not the job); the owner is emailed |
| `alert_generator_failed` | high | the alert job failed (raised once it works again) |
| from the audit log | as in `/admin/alerts` | `audit_verification_failed`, `file_integrity`, `malware_found`, `rescan_failed`, `reset_then_sign_in`, `ended_session_used`, `access_after_revoke`, `repeated_denials`, `break_glass`, `external_share`, `login_blocked` (one per account per hour) |

High and critical alerts are emailed to every active admin (never demo accounts): up to 10 one by one per run, the rest in one summary mail. Each escalation is recorded in the alert's history.

**Hard download limits.** Per person per rolling 24 hours (`download_daily_limit`, default 200) and per sign-in session (`download_session_limit`, default 100). Checked after the access decision and before the download is audited or any byte is sent. Over the limit: `429 {message, code: "download_limit_daily" | "download_limit_session"}`, audited as `document.download` `DENIED` with that reason.

## Download lifecycle

Every download has a `downloadId` in its audit details:

| Step | Audit action | Meaning |
|---|---|---|
| authorized (= started) | `document.download` `ALLOWED` | Access checked, limits checked, committed **before the first byte**. If this cannot be written, nothing is sent. Bytes start right after. |
| completed | `document.download_completed` `ALLOWED`, reason `all_bytes_handed_to_network` | Every byte was handed to the server's network stack. It does **not** prove the person received, saved or read the file. |
| interrupted | `document.download_interrupted` `FAILED`, reason `connection_closed_early` | The connection closed first; `bytesSent` says roughly how far it got. Part of the file may have been received. |
| failed | `document.integrity` `FAILED` | Decryption or the hash check failed after authorization; nothing was sent. |

Completion and interruption are written after the response and never delay it. An authorized download with neither (for example the server restarted mid-transfer) should be read as "may have been received". The web app and the Android app use the same routes, so the events are the same.

## Sign-in abuse resilience (THREATS.md S27-S29)

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/auth/login` | **public** | As above, plus: while the account is *under attack* (more than 10 attempts in an hour from untrusted devices) a browser without this account's trusted-device cookie gets **`202 {signInLinkSent: true, message}`** and no session, whatever the email and password. Only the right password for a usable account emails a one-time link. `429 {message: "Too many attempts. Try again later.", retryAfterSeconds}` for: 20 attempts per IP or 100 per network (IPv4 /24, IPv6 /48; 20 once the network is flagged for stuffing) per 15 minutes; 5 per (account, client) per 15 minutes, then that client is held off 15 minutes, doubling up to 24 h; an IP that failed on 6+ accounts in an hour, for an hour. Never a per-account lock. A full sign-in (after the second factor, if any) sets `__Host-tv_device` (HttpOnly, Secure, SameSite=Strict, 90 days, rotated each time). |
| POST | `/auth/login/link` | **public** | `{token}` from the emailed `/signin-link#token=…`. Same `200` body and cookies as a successful login (the second factor is still required if the account has one). One `400` message for any bad, used, expired, cancelled or pre-password-change link. 20 per IP per 15 minutes. |
| POST | `/auth/password/forgot` | **public** | Also 30 per network per 15 minutes; padded to `LOGIN_FAILURE_FLOOR_MS` like a failed login. |
| POST | `/auth/password/reset` | **public** | 20 per IP per 15 minutes. |
| POST | `/auth/password` | signed in | 5 tries at the current password per 15 minutes, then `429`. |
| POST | `/auth/mfa/totp/verify`, `/auth/mfa/passkeys/verify` | partial session | 5 per session per 5 minutes and 10 per account per 15 minutes; on the account's trusted device, 5 per 5 minutes for that device instead. |

Configuration: `DEVICE_TRUST_KEY` (32 bytes base64; without it a random key per process, so devices are forgotten on restart), `DEVICE_TRUST_DAYS` (90), `SIGNIN_LINK_MINUTES` (15).

New `/admin/alerts` kinds: `auth_abuse_detected`, `stuffing_from_ip` (high); `failed_sign_in_burst`, `sign_in_failure_spike` (medium). Computed from the audit log (`apps/api/src/audit/auth-abuse-alerts.ts`).

| Action | Outcome and reason |
|---|---|
| `auth.login` | New `DENIED` reasons: `rate_limited_pair`, `rate_limited_network`, `rate_limited_stuffing_ip`; while under attack `stepup_wrong_password`, `stepup_unknown_account`, `stepup_account_not_activated`, `stepup_account_deactivated`, `stepup_access_expired`, `stepup_link_sent` (right password, link emailed) and `stepup_link_not_sent` (right password, no mail or over 3 an hour). `details.trustedDevice` on failures. `ALLOWED` rows carry `details.via`: `password`, `trusted_device` or `signin_link`. The old `account_locked` and `wrong_password_locked_*` reasons are no longer written |
| `auth.signin_link` | Only refusals: `malformed_link`, `unknown_link`, `wrong_link_type`, `link_used`, `link_expired`, `not_eligible`, `password_changed` |
| `auth.account_under_attack` | Once an hour per account: `DENIED`, `many_failed_attempts`, with the attempt count, IP and network |
| `auth.credential_stuffing` | Once an hour per IP or network: `many_accounts_from_ip` (the IP is then refused for an hour) or `many_accounts_from_network` (its limit drops to 20) |
| `auth.distributed_guessing` | Once an hour per account: `many_networks_on_account` (4+ networks failed on it) |

| Email | Who gets it |
|---|---|
| Sign-in confirmation link (account under attack, right password, untrusted device) | The account holder: time, IP, the link, and what to do if it was not them |
