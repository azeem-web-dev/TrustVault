# Verifying TrustVault's audit log yourself

This document is the specification of TrustVault's audit log format. It is written so that you can build your own verifier **without reading or running any TrustVault code**, and without trusting the TrustVault server, its operator or its database.

Two verifiers already exist and agree on every case in `tools/independent-verify/agreement.test.mjs`:

| Verifier | Language | Written from |
|---|---|---|
| `tools/verify-audit.mjs` | Node.js, no dependencies | the implementation |
| `tools/independent-verify/verify.py` | Python 3.9+, standard library only (uses `cryptography` if installed) | **this document only** |

If you find a case where this document, either verifier and the database disagree, that is a security bug: please report it (see `SECURITY.md`).

Contents: 1. What you can and cannot learn · 2. Event encoding and the hash chain · 3. Signed checkpoints · 4. The export bundle · 5. Verification rules · 6. Sigstore Rekor · 7. The GitHub witness · 8. Test vector · 9. Running the verifiers

---

## 1. What you can and cannot learn

**What a successful verification shows**, subject to the trust boundaries below:

- No event in the bundle was changed, removed, inserted or reordered after the checkpoint covering it was signed.
- The checkpoints were signed with the Ed25519 key you pinned (the production audit key: `OMFkgIVZnsaXmuQkQv/Ibi8oEEEXveEbML5CtjdH+VE=`, key id `keyd-ed25519-v1`).
- With the public log (§6) or the GitHub witness (§7): the history in the bundle is the same history that was published at the time. Even someone holding the real signing key (for example with root on the server) cannot make a different history match what was already published, and cannot silently cut off events that were already covered by a published checkpoint.

**What it does not show** (we say this plainly; see `THREATS.md` L5, L8, I6):

- **Integrity is not completeness.** The chain proves that recorded events were not altered. It cannot prove that every action was recorded. An attacker with root on the server could make the application skip writing an event, or alter an event *before* it is chained. The design records access in the same database transaction as the action (`THREATS.md` L3) but that is a property of the code, not something a verifier can check.
- **The newest one or two minutes.** Events after the last checkpoint that was published (Rekor, about a minute after signing) or witnessed (GitHub, every 15 minutes) can still be rewritten or cut off by someone with root on the server.
- **Who was at the keyboard.** An event records which *account* acted, from which IP and user agent. It does not prove which human did, or that a recipient opened or read a file.
- **That the content of an event is true.** For example `ip` is what the server saw after its reverse proxy; `details` is what the application chose to record.
- **The key itself.** If the signing key leaks, a forger can sign new checkpoints. Checkpoints already in the public log or the witness branch still protect older history.

---

## 2. Event encoding and the hash chain

The database is the reference implementation: functions `audit_field`, `audit_canonical` and trigger `audit_chain_before_insert` in `apps/api/prisma/migrations/20261101071557_identity_and_audit/migration.sql`. No later migration changes them.

### 2.1 Fields

An event has these fields. In an export bundle every field is a **JSON string or JSON null** (never a number or object). The verifier must use the strings exactly as given, byte for byte, and never re-format them.

| # | Field | Form of the string | Can be null |
|---|---|---|---|
| 0 | *(constant)* | the literal `tv-audit-v1` | no |
| 1 | `seq` | decimal integer ≥ 1, no sign, no leading zeros | no |
| 2 | `id` | UUID, lowercase hex, `8-4-4-4-12` with hyphens | no |
| 3 | `occurred_at` | UTC time `YYYY-MM-DDTHH:MM:SS.ffffffZ`, always exactly 6 fractional digits (PostgreSQL `to_char(... AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`) | no |
| 4 | `actor_id` | UUID as above | yes |
| 5 | `actor_email` | text | yes |
| 6 | `action` | text, e.g. `document.download` | no |
| 7 | `outcome` | one of `ALLOWED`, `DENIED`, `FAILED` | no |
| 8 | `reason` | text | yes |
| 9 | `target_type` | text | yes |
| 10 | `target_id` | text | yes |
| 11 | `document_id` | UUID as above | yes |
| 12 | `ip` | text | yes |
| 13 | `user_agent` | text | yes |
| 14 | `request_id` | text | yes |
| 15 | `details` | PostgreSQL's text rendering of a `jsonb` value (see below) | yes |

`details` is hashed as **the text PostgreSQL prints for the `jsonb` value** (`details::text`): keys sorted by PostgreSQL's jsonb order (shorter keys first, then bytewise), `", "` between members and `": "` between key and value, e.g. `{"n": 1, "via": "web"}`. A verifier must treat it as an opaque string. Do **not** parse and re-serialise it: a JSON library will produce different bytes and every hash will fail.

A NULL and an empty string are different: NULL encodes as `~`, the empty string as `0:`.

### 2.2 Field encoding

Each field value `v` is encoded as:

- if `v` is NULL: the single byte `~` (0x7E);
- otherwise: the **number of bytes** of `v` in UTF-8, written in decimal ASCII, then `:` (0x3A), then the UTF-8 bytes of `v`.

Note it is the byte length, not the character length: `café` is `5:café`. The length prefix makes the encoding unambiguous: no value can be shifted into a neighbouring field without changing the bytes.

### 2.3 Canonical bytes

`canonical(e)` = the concatenation, with **no separators**, of the encodings of fields 0 to 15 in the order of the table.

### 2.4 Hash chain

```
hash(e)      = SHA-256( prev_hash(e) || canonical(e) )      -- 32 raw bytes
prev_hash(e) = hash(previous event by seq)
prev_hash    = 32 zero bytes for the first event ever written ("genesis")
```

`||` is byte concatenation; `prev_hash` is the 32 raw bytes, not hex. In a bundle, `prev_hash` and `hash` are 64-character lowercase hex.

The database assigns `seq`, `occurred_at`, `prev_hash` and `hash` itself, one writer at a time (an advisory lock held until commit), so chain order is commit order. `seq` comes from a sequence: it is strictly increasing but **may have gaps** (a transaction that rolled back still consumed a number). Gaps are not tampering; the `prev_hash` link is what proves nothing is missing. Likewise the first event's `seq` can be greater than 1; the zero `prev_hash` is what marks the start of the log.

---

## 3. Signed checkpoints

Every minute in which new events were written, the server signs the head of the chain. A checkpoint is:

| Field | Form |
|---|---|
| `seq` | decimal string, the seq of the event at the head |
| `headHash` | 64 lowercase hex: that event's `hash` |
| `signature` | standard base64 (with padding) of a 64-byte Ed25519 signature |
| `keyId` | text, `keyd-ed25519-v1` in production |
| `createdAt` | ISO 8601 UTC time the checkpoint was stored (e.g. `2026-11-01T07:21:00.512Z`) |

The signed message is the ASCII string

```
tv-checkpoint-v1|<seq>|<headHash>
```

for example `tv-checkpoint-v1|1|fa94d4986253dddfcd33c932c12797bf898810550e4df40fc794d590237949a0`. No newline, no trailing bytes. The signature is plain Ed25519 (RFC 8032, "PureEdDSA", not Ed25519ph, no context) over those bytes.

The public key is 32 raw bytes, given in base64. As an X.509 SubjectPublicKeyInfo (PEM) it is the DER prefix `302a300506032b6570032100` followed by the 32 bytes.

The signing key lives only in the key service `keyd` (a separate process and Linux user; derived from its master key with HKDF-SHA256, info `tv-audit-sign-v1`). keyd refuses to sign a checkpoint whose seq is not above the last one it signed, and the database refuses to store a checkpoint that does not name an existing event with exactly that hash, or that is not above the latest checkpoint (`20261102190000_checkpoint_guard`).

**Never take the public key from the bundle.** Anyone who rewrites a chain can make a new key and sign the forgery. Pin the published production key, or rely on §6/§7, which pin it for you.

---

## 4. The export bundle

An administrator downloads it from **Admin → Audit → Export** (`GET /api/admin/audit/export?fromSeq=1[&toSeq=N]`, admin with second factor; the export itself is audited as `audit.export`). It is one JSON object:

```jsonc
{
  "format": "trustvault-audit-bundle-v1",
  "exportedAt": "2026-11-03T10:15:02.123Z",   // server time of export
  "genesisPrevHash": "0000…0000",             // 64 zeros if exported from seq 1, else null
  "events": [                                  // ascending seq, at most 50 000
    { "seq": "1", "id": "…", "occurred_at": "…", "actor_id": null, "actor_email": "…",
      "action": "…", "outcome": "ALLOWED", "reason": null, "target_type": "…", "target_id": "…",
      "document_id": "…", "ip": "…", "user_agent": "…", "request_id": "…", "details": "{…}",
      "prev_hash": "<64 hex>", "hash": "<64 hex>" }
  ],
  "checkpoints": [                             // every checkpoint with first seq ≤ seq ≤ last seq, ascending
    { "seq": "…", "headHash": "<64 hex>", "signature": "<base64>", "keyId": "…", "createdAt": "…" }
  ],
  "signingKey": { "keyId": "keyd-ed25519-v1", "publicKey": "<base64>", "algorithm": "Ed25519" },
  "verifyWith": "…"                            // a hint string; ignore it
}
```

Ignore unknown fields. The export stops at 50 000 events; for a longer log export consecutive ranges with `fromSeq` and verify each with partial mode (you lose the tail checks of §5.5 for all but the last range).

---

## 5. Verification rules

A bundle is **intact** only if every rule below passes. Rule numbers match comments in `verify.py`.

### 5.1 Start of the log (B1)

- `format` must be `trustvault-audit-bundle-v1`, and `events` must be non-empty.
- *Full bundle* (the default): the first event's `prev_hash` must be 64 zeros. Otherwise events before it are missing.
- *Partial bundle* (the auditor asked for a range on purpose): the first `prev_hash` may be anything, but tail checks are then limited (5.5, 5.6).
- If `genesisPrevHash` is not null it must equal the first event's `prev_hash` (a bundle must not claim to start at the beginning when it does not).

### 5.2 Every event (B2–B4)

For events in array order:

- `seq` is a valid decimal and strictly greater than the previous event's.
- `prev_hash` equals the previous event's `hash` (not checked for the first one beyond 5.1).
- `hash` equals SHA-256(`prev_hash` bytes ‖ `canonical(e)`) (§2).

### 5.3 Checkpoints (C1–C4)

- If you pinned a key, `signingKey.publicKey` must equal it; verify signatures with the pinned key.
- There must be at least one checkpoint.
- For every checkpoint: an event with the same `seq` exists in the bundle; its `hash` equals `headHash`; the Ed25519 signature over `tv-checkpoint-v1|<seq>|<headHash>` is valid.

### 5.4 Unprotected tail (C5)

`exportedAt` must be a valid time. Let *newest* be the checkpoint with the highest seq. Events with a seq above it are not covered by any signature. That is normal right after activity (the next checkpoint is due within a minute), so it is accepted **only if** `exportedAt − newest.createdAt ≤ 5 minutes`; otherwise the bundle is rejected (newer checkpoints were removed, or events were added later). Report the number of uncovered events either way.

### 5.5 GitHub witness records (W1–W3), optional

Each witness record (§7) has `seq`, `headHash`, `witnessedAt`.

- W1: if the bundle has an event at the record's `seq`, that event's `hash` must equal the record's `headHash`.
- For records with `witnessedAt` **before** `exportedAt`, in a *full* bundle:
  - W2: if the record's seq is above the bundle's last seq, the bundle was cut short (reject);
  - W3: otherwise the bundle must contain a checkpoint at that seq, with the same `headHash`.
- In a partial bundle, records beyond the last seq are reported as unchecked.

### 5.6 Public log (Rekor), optional — see §6 for how to fetch entries

Let `digest(seq, hash) = lowercase hex SHA-256 of "tv-checkpoint-v1|<seq>|<hash>"`. For the entries signed with the pinned key:

- R1: at least one of the bundle's checkpoints must have its digest in the log.
- For each log entry whose digest is **not** one of the bundle's checkpoints and whose `integratedTime` is before `exportedAt`:
  - in a *full* bundle: reject. (It is either the checkpoint of an event in the bundle that the bundle no longer lists, or a checkpoint of history that the bundle does not contain: cut off or rewritten.)
  - in a *partial* bundle: accept it if its digest equals `digest(e.seq, e.hash)` for some event *e* in the bundle; otherwise report it as outside the range.
- Entries integrated after `exportedAt` are ignored (they post-date the export).

### 5.7 Verdict and exit codes

| Exit | Verdict | When |
|---|---|---|
| 0 | `INTACT` | all rules pass and at least one of: a pinned key, the witness, the public log |
| 0 | `CONSISTENT` | all rules pass, nothing pinned, and the auditor explicitly accepted self-consistency only |
| 2 | `UNVERIFIED` | all rules pass but nothing ties the bundle to the real key: a forger could have produced it |
| 1 | `TAMPERED` | any rule fails, or the input cannot be read |
| 64 | | usage error |

What each level of checking catches (from `agreement.test.mjs`):

| Attack | Key pinned | + witness | + public log |
|---|---|---|---|
| An event edited, deleted, inserted or reordered | caught | caught | caught |
| Whole chain recomputed and signed with a new key | caught | caught | caught |
| Chain rewritten and **re-signed with the real key** (root on the server) | not caught | caught (for history already witnessed) | caught (for history already published) |
| Newest events and checkpoints cut off | not caught | caught (if a later checkpoint was witnessed) | caught (if a later checkpoint was published) |

---

## 6. Sigstore Rekor (public transparency log)

Within about a minute of being signed, every checkpoint is submitted to Sigstore's public log at <https://rekor.sigstore.dev> by `tools/anchor.mjs` (a separate service on the server with no database or key-service access). Nobody, including us, can remove or change a Rekor entry.

**Entry type:** `rekord`, apiVersion `0.0.1`:

```json
{ "apiVersion": "0.0.1", "kind": "rekord",
  "spec": { "signature": { "format": "x509", "content": "<checkpoint signature, base64>",
                           "publicKey": { "content": "<base64 of the Ed25519 PEM>" } },
            "data": { "content": "<base64 of tv-checkpoint-v1|seq|headHash>" } } }
```

Rekor verifies the signature before accepting the entry and stores only `data.hash` = SHA-256 of the message (which is `digest(seq, headHash)` from §5.6), the signature and the public key, plus the time it received it (`integratedTime`, Unix seconds). It does not store the seq; you identify an entry by matching digests.

**Finding every entry for the audit key**, with `rekor-cli` (v1.x):

```bash
printf '%s' 'OMFkgIVZnsaXmuQkQv/Ibi8oEEEXveEbML5CtjdH+VE=' | base64 -d > raw.key
{ echo '-----BEGIN PUBLIC KEY-----'; ( printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; cat raw.key ) | base64; echo '-----END PUBLIC KEY-----'; } > trustvault-audit.pem
rekor-cli search --public-key trustvault-audit.pem --pki-format x509          # prints entry UUIDs
rekor-cli get --uuid <uuid> --format json                                   # one entry, with its body and inclusion proof
rekor-cli verify --uuid <uuid>                                              # checks the inclusion proof against the log
```

Or with plain HTTP:

```bash
curl -s https://rekor.sigstore.dev/api/v1/index/retrieve -H 'content-type: application/json' \
  -d "{\"publicKey\":{\"format\":\"x509\",\"content\":\"$(base64 -w0 trustvault-audit.pem)\"}}"
curl -s https://rekor.sigstore.dev/api/v1/log/entries/<uuid>
```

**For each entry, check** (both verifiers do):

1. Its **signed entry timestamp** (`verification.signedEntryTimestamp`): an ECDSA P-256 / SHA-256 signature by Rekor over the canonical JSON (keys sorted, no whitespace) of `{"body","integratedTime","logID","logIndex"}` from the entry. Rekor's public key is at `https://rekor.sigstore.dev/api/v1/log/publicKey` (pinned in both verifiers); `logID` must equal the hex SHA-256 of its DER encoding. Entries with an invalid receipt are reported as problems, never silently dropped.
2. The decoded `body` has `kind` `rekord`, `spec.data.hash.algorithm` `sha256`, and its public key is exactly the audit key's PEM.
3. Then use `spec.data.hash.value` as the entry's digest in rule 5.6.

The same checkpoint may appear under two UUIDs (Rekor shards); keep one per digest. The first production entry is log index 3633615638.

---

## 7. The GitHub witness

Every 15 minutes a GitHub Actions workflow (`.github/workflows/witness.yml`) that the server holds no credential for fetches the public checkpoint list (`GET https://vault.rayyanazeem.cloud/api/witness/checkpoints?since=N&limit=1000`, which shows only seq, hashes, signatures and times), checks that nothing it saw before has changed, and commits new checkpoints to the `witness` branch of <https://github.com/azeem-web-dev/TrustVault>.

```bash
git clone --branch witness --single-branch https://github.com/azeem-web-dev/TrustVault tv-witness
```

| File | Content |
|---|---|
| `signing-key.json` | the audit key pinned on the first run: `{"keyId","publicKey","algorithm","pinnedAt"}` |
| `checkpoints.jsonl` | one JSON object per line: `{"seq","headHash","signature","keyId","createdAt","witnessedAt", "rekorLogIndex"?, "rekorIntegratedTime"?}` |
| `public-log.jsonl` | Rekor entries already matched to a checkpoint: `{"uuid","logIndex","integratedTime","digest","seq"}` |

Use `checkpoints.jsonl` for rule 5.5. You can also check each line's signature yourself (§3). The branch's git history shows when each line was added; GitHub, not TrustVault, controls those commit times.

The witness is only as trustworthy as the GitHub repository's access controls. The repository owner could rewrite the branch; the public log in §6 does not have that weakness, which is why we use both.

---

## 8. Test vector

```
event:
  seq "1", id "0b6f3c1e-8f4c-4d7a-9a51-2f1d3c4b5a69", occurred_at "2026-11-01T07:20:31.123456Z",
  actor_id null, actor_email "system", action "auth.login", outcome "DENIED", reason "café",
  target_type null, target_id null, document_id null, ip "203.0.113.7", user_agent "" (empty),
  request_id null, details "{\"n\": 1, \"via\": \"web\"}", prev_hash 64 zeros

canonical (UTF-8):
11:tv-audit-v11:136:0b6f3c1e-8f4c-4d7a-9a51-2f1d3c4b5a6927:2026-11-01T07:20:31.123456Z~6:system10:auth.login6:DENIED5:café~~~11:203.0.113.70:~22:{"n": 1, "via": "web"}

hash:      fa94d4986253dddfcd33c932c12797bf898810550e4df40fc794d590237949a0
message:   tv-checkpoint-v1|1|fa94d4986253dddfcd33c932c12797bf898810550e4df40fc794d590237949a0
digest:    e8d432999096c6bf79b07cae85024830f7832f70f96c4eba54ff40a0c0bec28d
test key:  6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=   (Ed25519 seed = 32 bytes of 0x07; a TEST key)
signature: btMiTELmQskVUUA+1q3QYCm4PfPV0cx4V7FF16feMNqlVe5V649jTKq2tuf+PBg+qRJe55iQHAblY9msyUQ5Cg==
```

---

## 9. Running the verifiers

```bash
# Python (no install needed; `pip install cryptography` makes it faster)
python3 tools/independent-verify/verify.py trustvault-audit-1-5000.json \
    --key OMFkgIVZnsaXmuQkQv/Ibi8oEEEXveEbML5CtjdH+VE= \
    --witness tv-witness/checkpoints.jsonl --rekor

# Node 20+
node tools/verify-audit.mjs trustvault-audit-1-5000.json \
    --key OMFkgIVZnsaXmuQkQv/Ibi8oEEEXveEbML5CtjdH+VE= \
    --witness tv-witness/checkpoints.jsonl --rekor
```

`verify.py` also takes `--rekor-entries file.json` (a JSON array of `{logIndex, integratedTime, digest}` you fetched and checked yourself) for air-gapped use, `--partial` for a deliberate range, and `--json` for machine-readable output. Only `--rekor` uses the network, and only to talk to rekor.sigstore.dev.

To check that the two verifiers still agree: `node tools/independent-verify/agreement.test.mjs` (CI runs it on every push). `apps/api/test/independent-verify.test.ts` runs both on a bundle exported by the real API from a real database.
