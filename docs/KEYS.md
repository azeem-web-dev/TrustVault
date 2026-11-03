# Keys: hierarchy, independent authorisation, key-use ledger, rotation

This covers checklist items 5 (the key service authorises decryption itself), 6 (an independent, signed key-unwrap ledger with reconciliation), 7 (rotation and re-wrapping) and 25 (hardware-backed key storage: evaluation only). The threat rows are THREATS.md K5–K14.

## 1. The short version

- The API can no longer ask keyd to unwrap a document data key on its own say-so. It must present a **ticket** that only the database can mint, by a function that runs as the schema owner and checks the caller's access level, a fresh ALLOWED audit event for exactly that access, and quarantine. The ticket is MACed with a key the application's database role cannot read. keyd checks the MAC, expiry (30 s, at most 60 s), single use, the exact document version and wrapped key, and per-user rate limits.
- keyd writes every key release, every refusal, every TOTP unwrap, every rewrap and every start to **its own hash-chained ledger**, fsynced before the key leaves the process, in a directory only the `tvkeyd` user can read. Signed heads of that ledger are published to Sigstore Rekor next to the audit checkpoints.
- The API **reconciles** that ledger with the audit log every hour (and on demand). A key release without a matching audit event, an ALLOWED download without a key release, a ticket the database never issued, a forged-ticket probe: each is a finding, an audit event and an admin alert. An offline tool does the same from keyd's file and an audit bundle without trusting the server.
- Wrapping keys are **versioned** (`keyd-g<N>-blob`, `keyd-g<N>-totp`, one HKDF label per class per master generation). `keys.js rotate` re-wraps everything through keyd (`rewrap`: no data key ever leaves keyd), resumably; `keys.js reencrypt` replaces data keys and ciphertexts after a data-key compromise.

## 2. Key hierarchy

```
/etc/tvkeyd/master.key            generation 1, 32 random bytes (root 0400; keyd gets it via LoadCredential)
  ├─ HKDF "tv-wrap-g1-blob"         keyd-g1-blob     AES-256-GCM, wraps document data keys
  ├─ HKDF "tv-wrap-g1-totp"         keyd-g1-totp     AES-256-GCM, wraps TOTP secrets
  ├─ HKDF "tv-wrap-v1"              keyd-wrap-v1     legacy (before generations): still opens, never wraps
  ├─ HKDF "tv-audit-sign-v1"        keyd-ed25519-v1  Ed25519, audit checkpoints (unchanged)
  └─ HKDF "tv-unwrap-ledger-sign-v1" keyd-ledger-ed25519-v1  Ed25519, key-ledger heads
/etc/tvkeyd/extra/master-N.key    generation N (rotation)
  ├─ HKDF "tv-wrap-gN-blob"         keyd-gN-blob
  └─ HKDF "tv-wrap-gN-totp"         keyd-gN-totp
/etc/tvkeyd/ticket.key            32 random bytes: MAC key of unwrap tickets (also in table keyd_ticket_keys)
/etc/tvkeyd/extra/ticket-prev.key previous ticket key, only while rotating it

per document version: a random 256-bit data key (AES-256-GCM over the file, AAD
  tv-blob-v1|<document>|<version>|<number>), stored wrapped under keyd-gN-blob with the same AAD.
per user: TOTP secret wrapped under keyd-gN-totp, AAD tv-totp-v1|<user>.
```

The class of a wrapped value is decided by its AAD and enforced twice: separate keys per class, and keyd refusing a key id whose class differs from the AAD's. Only those two AAD shapes are accepted at all. The development `LocalKeyProvider` uses the same labels with `local-` key ids (`local-v1` is its legacy id).

| Secret | Where | Who can read it |
|---|---|---|
| master keys | `/etc/tvkeyd/master.key`, `/etc/tvkeyd/extra/master-N.key` | root; keyd (a private copy from systemd) |
| ticket key | `/etc/tvkeyd/ticket.key` and table `keyd_ticket_keys` | root; keyd; the database **schema owner** (not `trustvault_app`) |
| key-use ledger | `/var/lib/tvkeyd/unwrap-ledger.jsonl` (StateDirectory, 0700) | root; keyd. The API sees it only through `ledger_read` |
| database owner URL | `/etc/trustvault/migrate.env` | root (deploy and key tools only; the running API never has it) |

**Environments.** Production, staging and development never share a key: `install-keyd.sh` generates both files on each server; development uses `LOCAL_MASTER_KEY` and a ticket key derived from it (`tv-local-ticket-key-v1`), and `loadEnv()` refuses the local provider in production. Never copy a production key to another machine except as part of the encrypted backup.

## 3. Who may unwrap what (policies per operation)

| Operation | Policy in keyd | Why |
|---|---|---|
| Upload (wrap a new data key) | no ticket | Wrapping reveals nothing: the caller already has the plaintext key it sends. New wraps always use the current generation |
| Download (`download`) | ticket required: user, READ level, ALLOWED `document.download` event, not quarantined; user rate limits | The core path |
| View-only page rendering, offline keys | same mechanism, one row in `unwrap_actions` each (section 8) | Not on this branch |
| Nightly malware re-scan (`rescan`) | system ticket (no user), ALLOWED `document.rescan_decrypt` event per version; capped by `KEYD_LIMIT_SYSTEM_PER_HOUR` (default 2000, **0 disables re-scan decryption**) | The re-scan must read every file; this is the widest path a compromised API keeps (section 5) |
| Emergency re-encryption (`reencrypt`) | ticket from `tv_issue_maintenance_ticket()`, which only the schema owner can execute; keyd refuses unless the operator set `KEYD_LIMIT_MAINT_PER_HOUR` > 0 | Needs both root-only credentials (owner URL) and a keyd config change |
| Rotation (`rewrap`), verification (`check`) | no ticket; rate-limited; rewraps ledgered | The plaintext never leaves keyd, so these grant nothing |
| TOTP secret unwrap | **no ticket** (documented exception), per-user limit `KEYD_LIMIT_TOTP_PER_USER_10MIN` (20) and `KEYD_LIMIT_TOTP_ALL_PER_MIN` (120 per minute overall), ledgered as `totp_unwrap` | See below |
| Break-glass | an admin with a live break-glass row has level 1, so downloads go through the normal ticket path, audited and alerted | No separate keyd capability exists |
| Recovery (lost server) | the encrypted backup holds `/etc/tvkeyd` (master keys and ticket key) | docs/RESTORE.md; restore `ticket.key` and `extra/` too, then `keys.js status` |

**TOTP exception, justified.** A TOTP secret only proves a second factor *to this API*. Whoever controls the API process already controls every sign-in decision, so a ticket would protect nothing there, and the database cannot verify a password or a code (both are checked in the API). The secret is still bound to its user by its AAD, cannot open any document key (separate key and AAD class, tested), is rate-limited per user and every unwrap is ledgered, so bulk extraction of TOTP secrets is visible in the ledger. After an API compromise, reset second factors (section 7).

**When things are down.** keyd cannot reach the database and does not try: without a ticket there is no document key, so if the database (or the ticket function) is unavailable, downloads fail closed with 404/503. If keyd is down or refuses (rate limit, ledger write failure), downloads fail with 503/429 and a `document.download` DENIED/FAILED event with reason `key_service_refused`; that is not reported as a file-integrity problem. If keyd's ledger cannot be written (disk full), keyd refuses every unwrap.

## 4. Unwrap tickets

```
tv-unwrap-ticket-v1|kid|tid|action|doc|ver|user|aad_sha256|wk_sha256|audit_id|audit_seq|iat|exp|mac
  kid       first 16 hex of SHA-256("tv-ticket-kid-v1|" || ticket key)
  tid       random ticket id (single use)
  user      the transaction's app.user_id, or "-" for system actions (rescan, reencrypt)
  aad_sha256, wk_sha256   SHA-256 of the exact AAD and wrapped key in document_blobs
  audit_id, audit_seq     the ALLOWED audit event that backs this ticket
  iat, exp  unix seconds, exp = iat + 30 (keyd accepts at most 60, 5 s clock skew)
  mac       hex HMAC-SHA256(ticket key, everything before "|mac")
```

Minted by `tv_issue_unwrap_ticket(version, action, audit_event)` (migration `20261103400000_unwrap_tickets`), called by the API inside the transaction that wrote the audit event, right after writing it (`apps/api/src/crypto/tickets.ts`). It refuses, raising `insufficient_privilege` and rolling the transaction back, when: the action is unknown; the user's `tv_doc_level` is below the action's `min_level` (admins: 0 without break-glass); a system action runs inside a user transaction or vice versa; the version is quarantined (downloads); the audit event is missing, not ALLOWED, older than 60 s, for another action, document, user or version number; or that event already backs a ticket. Every issued ticket is recorded in `unwrap_tickets` (insert-only, readable by the app for reconciliation). HMAC is implemented with the built-in `sha256()`; the three implementations (SQL, Rust, TypeScript) are pinned to the same test vector.

keyd (`keyd/src/ticket.rs`) checks, in order: strict format; known kid; MAC (constant time); lifetime; not expired, not issued in the future; the AAD starts with `tv-blob-v1|<doc>|<ver>|` and hashes to `aad_sha256`; the wrapped key hashes to `wk_sha256`; tid not used before (memory, rebuilt from the ledger after a restart); rate limit; then unwraps, ledgers, and only then returns the key. A ticket is consumed by its first attempt whatever happens next.

## 5. What a compromised API can still do (the honest boundary)

Compromising the API process (its code, memory and database role) no longer gives unrestricted decryption:

- It cannot unwrap without a ticket, forge one (no ticket key: the table is unreadable and the minting functions are not executable by its role), reuse one, or use one for another document, version or wrapped key. Tested in `keyd-tickets.test.ts` ("compromised API") and `keyd/src/main.rs` tests.
- It **can** set `app.user_id` to any active user and obtain tickets for documents *that user* may read, because the database cannot tell a real request from an impersonated one. Every such release then needs an ALLOWED audit event attributed to that user (so it is in the tamper-evident audit log, checkpointed and anchored), is in keyd's ledger, is limited to 60/min and 600/h per user and 600/min overall, and shows up in reconciliation (`unwrap_volume`). Administrators get nothing this way (no level without break-glass), and nobody can obtain keys for documents no active user can read (e.g. in the trash, owners excepted).
- It can obtain `rescan` tickets for any version, up to `KEYD_LIMIT_SYSTEM_PER_HOUR` per hour, each audited (`document.rescan_decrypt`) and ledgered. Deployments with high-value data should set this to 0 (re-scanning then stops at the key service, reported as `key_service_rate_limited`) or a small number.
- It can obtain TOTP secrets (section 3), rate-limited and ledgered.
- It can issue a ticket inside a transaction and roll it back, so no audit event or ticket record remains. keyd cannot see the database and releases the key, but the ledger entry names an audit event and ticket that do not exist: reconciliation reports `release_without_audit` and `release_without_issued_ticket` (critical). Detectable, not preventable.

Next steps that would narrow this further: bind tickets to a live session verified inside the database (session rows written only by SECURITY DEFINER functions, ticket function checks the session's token hash), or per-download user signatures (passkey assertion over the request) verified by keyd. Neither is built.

## 6. The key-use ledger and reconciliation

**Entry** (`keyd/src/ledger.rs`, one JSON line): `seq, ts (ms), event (start|unwrap|refuse|totp_unwrap|rewrap), action, tid, user, doc, ver, audit_id, audit_seq, key_id, aad_sha256, result ("ok" or the reason), detail, prev, hash`. `hash = SHA-256(prev || canonical)`, canonical = the fields in that order, each `~` (null) or `<utf8 length>:<value>`, prefixed `tv-unwrap-ledger-v1`. The first entry links to 32 zero bytes. keyd verifies the whole chain at start and refuses to start on a broken one; an unterminated last line (a crash mid-write; never acknowledged, since each entry is fsynced before the key is released) is cut off. Refusals beyond `KEYD_LIMIT_REFUSALS_LOGGED_PER_MIN` (120) are counted and the count is written with the next logged refusal, so a flood cannot fill the disk.

**Signed heads.** `ledger_head` returns `tv-unwrap-ledger-v1|<seq>|<hash>` signed with the ledger key (distinct from the audit key; keyd signs only its own head, nothing chosen by the caller).

**Mirror** (`KeyLedgerService.mirror`, every minute): reads new entries, re-verifies every link and hash, inserts them into `keyd_ledger_entries` (insert-only; a trigger refuses rows that do not extend their chain), verifies the signed head against the first ledger key ever recorded and stores it in `keyd_ledger_checkpoints`. Each ledger file is an **epoch** named by its first entry's hash; a new epoch (keyd's state directory replaced or lost) is reported as `keyd.ledger` FAILED, never silently accepted.

**Publishing.** `GET /api/witness/keyd-ledger` (public, like `/witness/checkpoints`) lists signed heads. `tools/anchor.mjs` (already run every minute by `trustvault-anchor.timer`) now also submits each head to Rekor, pinning the ledger key on first use (`ledger-key.json`, `ledger-anchored.jsonl` in its state directory). A rewritten ledger no longer matches heads already in Rekor.

**Reconciliation** (`KeyLedgerService.reconcile`, hourly, `POST /api/admin/keyd/reconcile`): over ledger entries and audit events new since the last run (audit events younger than 2 minutes wait for the next run):

| Finding | Severity | Meaning |
|---|---|---|
| `ledger_integrity` | critical | the ledger does not verify, its head signature or key changed, or a new epoch started |
| `release_without_audit` | critical | keyd released a key whose ticket names an audit event that does not exist or does not match (action, ALLOWED, document, user, seq) |
| `release_without_issued_ticket` | critical | keyd accepted a ticket with no matching `unwrap_tickets` row (rolled-back transaction, or a stolen ticket key) |
| `ticket_used_twice` | critical | keyd itself misbehaved |
| `release_without_ticket` | critical | an ALLOWED download/rescan/re-encryption event with no ticket at all, after tickets were introduced: bytes served outside the protocol |
| `keyd_probe` | critical | refusals a correct API never causes: missing, forged, malformed or mis-bound tickets |
| `ticket_not_used` | warning | a ticketed ALLOWED event whose ticket keyd never saw (keyd down, request died, or a cached key) |
| `keyd_refusal`, `unwrap_failed` | warning | rate limits, expired or reused tickets, failed unwraps |
| `unwrap_volume` | warning | more than 200 releases for one user since the last run |
| `keyd_restarted` | info | keyd started |

Each run writes `keyd.reconcile` (ALLOWED or FAILED, with counts and the first findings); FAILED runs and `keyd.ledger` problems appear in `GET /api/admin/alerts` as `key_ledger_mismatch` (critical).

**Offline, without trusting the server:** copy `/var/lib/tvkeyd/unwrap-ledger.jsonl` off the server, export an audit bundle and verify it with `tools/verify-audit.mjs`, then
`node tools/reconcile-ledger.mjs --ledger unwrap-ledger.jsonl --audit bundle.json --heads ledger-anchored.jsonl [--ledger-key <base64>]`.

**What root (or anyone with the master key) can still do.** Read every key and the ledger; rewrite the ledger and re-sign heads (the ledger key derives from the master key). Heads already anchored in Rekor then stop matching (`ledger_rewritten`), but entries written after the last anchored head (normally under a minute) can be removed without trace, and root can decrypt documents directly with the master key without ever asking keyd. The ledger makes *application-level* releases detectable; it does not make a root compromise detectable (THREATS.md I6). Hardware key storage (section 9) is what would change that.

## 7. Rotation and recovery procedures

All commands run on the server as root unless stated; `KEYS` below means
`sudo -u trustvault -H env DATABASE_OWNER_URL="$(sed -n 's/^DATABASE_OWNER_URL=//p' /etc/trustvault/migrate.env)" KEY_PROVIDER=keyd node /opt/trustvault/app/apps/api/dist/cli/keys.js`.

**Check state:** `$KEYS status` (generations, ticket key ids loaded by keyd vs active in the database, how many values per key id). Exit 1 if keyd does not hold the database's active ticket key.

**First deployment of this feature** (existing data stays readable: `keyd-wrap-v1` values open with a ticket):
1. `bash infra/server/deploy.sh` (migration, ticket key import if it exists).
2. `bash infra/server/install-keyd.sh` (generates `/etc/tvkeyd/ticket.key`, creates `/etc/tvkeyd/extra`, imports the ticket key, installs the new unit, restarts keyd).
3. `$KEYS status`, then optionally `$KEYS rotate` to move legacy `keyd-wrap-v1` values to `keyd-g1-blob`/`-totp` (class separation for old data).
Between steps 1 and 2 downloads keep working: the old keyd ignores tickets.

**Routine wrapping-key rotation (new master generation):**
1. `( umask 077; head -c 32 /dev/urandom > /etc/tvkeyd/extra/master-2.key ); chmod 0400 /etc/tvkeyd/extra/master-2.key`
2. `systemctl restart tvkeyd` — new wraps now use `keyd-g2-*`; old values still open.
3. Take a backup (`systemctl start trustvault-backup`) so the new key is in it **before** anything depends on it.
4. `$KEYS rotate` — re-wraps every document key and TOTP secret; small compare-and-swap transactions; interrupt and re-run at will; ends with `verify`.
5. When `$KEYS verify` reports everything current: add `KEYD_RETIRED_GENERATIONS=1` to `/etc/tvkeyd/keyd.env`, restart keyd, `$KEYS verify` again. Keep `master.key` (it still derives the signing keys) and keep old generation files in offline backups until no backup that needs them is within retention.
Rollback: remove the retirement line (and, before step 4 finished, the new key file) and restart; values carry their key id, so mixed states always open.

**Ticket key rotation:** `cp -a /etc/tvkeyd/ticket.key /etc/tvkeyd/extra/ticket-prev.key`; write a new `ticket.key`; `systemctl restart tvkeyd` (accepts both); `bash /opt/trustvault/app/infra/server/ticket-key.sh` (database switches to the new one); after a minute remove `ticket-prev.key` and restart keyd.

**Emergency: suspected compromise of the API host or the database (not the master key).** Rotate the ticket key (above); reset every user's second factor; review the last reconciliation and run the offline one; lower `KEYD_LIMIT_*` while investigating.

**Emergency: suspected master-key compromise.** Assume every wrapped data key and TOTP secret could be unwrapped by the attacker, and with the database, every file read.
1. New generation as above (steps 1–3), then `$KEYS rotate`, then retire generation 1 for wrapping (`KEYD_RETIRED_GENERATIONS=1`).
2. Data keys themselves may be known: re-encrypt. Set `KEYD_LIMIT_MAINT_PER_HOUR=100000` in `/etc/tvkeyd/keyd.env`, restart keyd, run `$KEYS reencrypt` (resumable by run id; each version: new random data key, new nonce and ciphertext, same AAD, SHA-256 checked before and after, compare-and-swap; every unwrap audited as `keys.reencrypt_version` and ledgered as `reencrypt`). Then set the limit back to 0 and restart.
3. The audit and ledger signing keys derive from `master.key` and must be treated as compromised too: publish a statement with the time of compromise; replacing them means a new `master.key` (which also re-keys generation 1), re-pinning the anchor (`signing-key.json`, `ledger-key.json`) and the GitHub witness, and verifying old bundles with the old public key. This is a manual, documented procedure, not automated here.
4. Reset all second factors, rotate the ticket key, rotate database passwords.

**Restore from backup** (docs/RESTORE.md): restore all of `etc/tvkeyd/` (`master.key`, `ticket.key`, `extra/`), then `$KEYS status`. The ledger (`/var/lib/tvkeyd`) is not in the backup; a restored keyd starts a new epoch, which the mirror reports once.

**Compatibility.** Key ids are stored with every wrapped value (`document_blobs.key_id`, the packed TOTP blob), so any mix of generations decrypts as long as the generation is loaded and not retired. Re-encryption keeps the blob format (`nonce(12) | tag(16)` columns, AES-256-GCM, AAD unchanged). Older API versions keep working against the new keyd only for wraps and TOTP; their downloads are refused (no ticket).

## 8. Adopting tickets in another decrypting path (view-only branch)

Page rendering (`tv_render_source`) and offline keys decrypt too. To adopt the protocol:
1. In that branch's migration, add a row: `INSERT INTO unwrap_actions (action, audit_action, min_level, system, refuse_quarantined) VALUES ('view_page', 'document.view_page', <VIEW level>, false, true), ('offline_key', 'document.offline_key', <level>, false, true);` (with a new VIEW level below READ, also check `download`'s `min_level` still means "may download").
2. In the access transaction, write the ALLOWED audit event with `details.versionNo`, then `const ticket = await issueUnwrapTicket(tx, versionId, 'view_page', event.id)`; pass it to `openFile(keys, sealed, aad, ticket)` (the signature now requires it).
3. If rendering runs outside a user transaction (a worker), either issue the ticket in the request transaction and hand it over (30 s), or add a system action (then also add its name to keyd's `SYSTEM_ACTIONS` and the TypeScript `SYSTEM_ACTIONS`).
4. Rate limits: one unwrap per page would hit 60/min per user; render all pages from one unwrap per view, or raise `KEYD_LIMIT_USER_PER_MIN`.
5. Reconciliation picks the new audit action up automatically from `unwrap_actions`.

## 9. Hardware-backed key storage: evaluation (not built)

Today the master keys are files readable by root and loaded into keyd's (locked, non-dumpable) memory. Anyone with root, or a hypervisor-level attacker, can copy them. Options for the current host, a Hostinger KVM VPS:

| Option | Availability on a Hostinger VPS | What it would change | Cost / trade-off |
|---|---|---|---|
| **TPM 2.0 sealing** (`systemd-creds encrypt --with-key=tpm2`, `LoadCredentialEncrypted=`) | Not offered as a documented feature on Hostinger KVM VPS plans as far as I know; verify on the box with `ls /dev/tpm*` and `systemd-creds has-tpm2` before relying on it | Key files encrypted at rest, bound to the machine; a stolen disk image or backup copy of `/etc/tvkeyd` is useless. Does **not** stop live root (systemd decrypts it for keyd at start) | Free where present. Without a TPM, `systemd-creds encrypt --with-key=host` still binds the files to `/var/lib/systemd/credential.secret` (protects copies, not root) |
| **Cloud KMS** (AWS KMS, GCP Cloud KMS, Azure Key Vault) as the wrapping root: keyd calls `Decrypt` on an encrypted generation key at start, or for every unwrap | Reachable over the internet from the VPS; needs keyd to get network access (today `PrivateNetwork=yes`) and a cloud credential on the server | Envelope root outside the VPS; KMS audit logs (CloudTrail) become an **independent second ledger** for per-unwrap mode; keys can be disabled remotely in an emergency. Per-unwrap mode: a stolen database plus root still needs live KMS access, which can be revoked and is logged. Startup-only mode: equivalent to files once running | ~USD 1/key/month + 0.03 per 10k requests (AWS); a network dependency for downloads (per-unwrap); the cloud credential on the server becomes the new secret to protect (use short-lived, IP-restricted credentials) |
| **YubiHSM 2 / network HSM** | Not possible on a VPS (no USB passthrough); needs a dedicated or colocated server, or a cloud HSM (AWS CloudHSM, ~USD 1.5/h) | Keys generated and used inside the HSM, never exportable: root can *use* them while it controls the host, but cannot copy them; HSM audit log is a hardware-backed ledger | Hardware cost (~USD 650 per YubiHSM 2, two for redundancy) or CloudHSM cost; key backup ceremony with wrap keys split between custodians |
| **Customer-managed keys (BYOK/HYOK)** | Product decision | Each customer's generation key wrapped by a key in *their* KMS; they can revoke TrustVault's access | Per-tenant generations (the key-id scheme already allows it); operational complexity |

Recommendation for this deployment: (1) now, `systemd-creds encrypt --with-key=host` for `master*.key` and `ticket.key` so copies of `/etc/tvkeyd` outside the box are useless (backups are already age-encrypted); (2) if confidentiality must survive a host compromise, per-unwrap cloud KMS with keyd as the only caller (gives a second, provider-run unwrap log), keeping the ticket check in front of it; (3) a real HSM only with a move to dedicated hardware.

**Custody, backup, destruction.** Master keys: generated on the server, backed up only inside the age-encrypted nightly archive whose private key is held offline by the owner; a generation is destroyed (shred the file, drop it from backups past retention) only after `keys.js verify` shows no value uses it and no retained backup needs it. Ticket key: no backup needed for recovery (a new one can be generated and installed at any time); it is in the archive only for convenience. Ledger: evidence, kept on the server; heads are public in Rekor.
