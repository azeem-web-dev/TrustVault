# Optional end-to-end encryption: design

Checklist item 26. **Not built.** This is a design for an optional mode, kept separate from the current model so it can be judged on its own. THREATS.md "Not built, on purpose" explains why the default is server-side encryption; this page explains what an opt-in alternative would look like, what it would cost, and what it would not change.

## 1. Threat model: what changes and what does not

| | Current model (server-side encryption) | E2E mode |
|---|---|---|
| Who can decrypt a stored file | the server (keyd holds the master key) for any authorized request | only devices of people the file was shared with |
| Root on the server (THREATS I6) | can read every document | **cannot read** E2E documents (only ciphertext, sizes, names if not encrypted, access patterns). Can still serve malicious web code to steal keys next time a user signs in (§7) |
| Malicious admin | break-glass gives an hour of READ, audited | break-glass **impossible** for E2E documents unless an escrow key is configured (§5) |
| Authorization | server decides; RLS enforces | server still decides who may **fetch ciphertext** and who receives wrapped keys; cryptography decides who can **read** |
| Revocation | immediate: next request refused | refuses future fetches; the revoked person may have kept the file key (as they may have kept a download today). Forward secrecy for new versions needs a re-key (§4.4) |
| Audit | every access recorded by the server | the server records fetches of ciphertext and key envelopes; it **cannot** see decryption. "Received" still means "the server released the bytes", as today |
| Malware scanning, previews, search, watermarking | server-side | **not possible server-side** (§6) |

E2E is a **different security model, not a stronger version of the same one**. It protects against a compromised server at the cost of server-side checks. It is not a substitute for authorization or accountability: both still run on the server and still matter.

## 2. Keys

| Key | Type | Where it lives | Purpose |
|---|---|---|---|
| Device key pair | X25519 (encryption) + Ed25519 (signing), generated on the device | private halves never leave the device: WebCrypto non-extractable keys in IndexedDB (web), Android Keystore-wrapped (app) | one per device per user |
| User identity key | Ed25519 | derived from / protected by the recovery secret (§5); signs the user's device list | lets others check a device belongs to the user |
| Document key (DK) | 256-bit random, per document **version** | only ever stored wrapped | encrypts the file (AES-256-GCM, as today) |
| Key envelope | DK encrypted to one device public key (HPKE, RFC 9180: DHKEM(X25519), HKDF-SHA256, AES-256-GCM) | server database, one row per (version, device) | delivers a DK to a device |
| Group key | per group, per epoch | envelopes to each member's devices | share once with a group instead of every device (§4.3) |

Everything uses standard, audited primitives (WebCrypto / Android Keystore / libsodium-class libraries). No custom cryptography.

## 3. Device enrolment and key directory

1. On first sign-in on a device, the client generates the device key pair and uploads the public half.
2. The user's identity key signs the updated device list (`tv-devices-v1|user|epoch|sorted device keys`). The server stores and serves the signed list; it cannot add a device without the identity key.
3. **Key transparency:** every signed device list goes into an append-only log on the server **and its checkpoints into the same Rekor/witness pipeline the audit log already uses** (VERIFY.md §6–7). Clients check that the list they receive is consistent with the published head. This is what stops a compromised server from silently adding its own "device" to a user (the classic attack on E2E systems). Users can compare a short safety code for each other out of band for high-value shares.
4. A new device must be approved from an existing device (QR code) or by entering the recovery secret.

## 4. Sharing

### 4.1 Upload

Client generates DK, encrypts the file, encrypts DK to the uploader's own devices, uploads ciphertext + envelopes + the plaintext SHA-256 **encrypted** under DK (the server can no longer check it; the recipient's client does).

### 4.2 Share with a person

The sharer's client fetches the recipient's signed device list, verifies it against the key-transparency log, and uploads envelopes of DK for each recipient device. The server records the grant (same `grants` table, same `decide()` and RLS) and only returns ciphertext and envelopes to authorized users.

### 4.3 Groups

Each group has a group key per **epoch**. Sharing with a group = one envelope of DK to the group key. Adding a member = envelopes of the current group key to their devices (their client can then read documents shared with the group, which matches today's semantics only after owner confirmation of new members: the owner's client creates those envelopes, so confirmation becomes cryptographic). Removing a member = new epoch: a new group key distributed to the remaining members; documents shared after that use the new key. Documents shared before can be re-wrapped to the new epoch by an owner's client (DKs only, not file content).

### 4.4 Revocation and new versions

Revoking deletes the envelopes and refuses fetches (as today). Because the revoked person might have kept DK, the **next version** always gets a fresh DK; owners can choose "re-encrypt current version" which uploads the file again under a new DK (the only real forward secrecy for content they already had).

## 5. Recovery and loss

The hard part. Options, per organisation:

| Option | How | Trade-off |
|---|---|---|
| **Recovery secret** (default) | at enrolment the user writes down a 24-word recovery code; it derives a key (Argon2id) that encrypts a backup of the identity key and a "recovery device" key that receives envelopes like any device | lose all devices **and** the code: documents are gone. That must be said plainly at enrolment |
| **Organisation escrow** | an organisation recovery key (held offline, split with Shamir 2-of-3 among named officers) receives envelopes for every E2E document | restores break-glass and legal hold; but the escrow holders can read everything, so the server compromise threat moves to them. Every escrow use is a signed, audited event |
| **None** | for the most sensitive documents only | no recovery at all |

Versioning: each version has its own DK, so recovering one version does not expose others.

## 6. What stops working, or must move to the client

| Feature | In E2E mode |
|---|---|
| Malware scanning (ClamAV on upload, nightly re-scan, quarantine) | **cannot run on the server.** Options: scan on the uploader's device (weak: a malicious uploader skips it), scan on each recipient's device before opening, or declare E2E documents unscanned. Must be visible to recipients |
| Content-type validation | client-side only; server sees ciphertext |
| Search | titles and descriptions encrypted → client-side search over metadata the client has decrypted; no server search. Titles can be left in plaintext per organisation choice (they are then visible to the server and to root) |
| Previews / view-only rendering | server-side rendering impossible; rendering must be in the client, which weakens "view-only" further (the client has the plaintext) |
| Watermarking | client-side only, i.e. advisory: a modified client can skip it |
| Integrity check on download (SHA-256 today) | moves to the recipient's client (encrypted hash + AES-GCM authentication) |
| Admin break-glass | impossible without escrow (§5) |
| Server-side retention purge | still deletes ciphertext; cannot verify content |
| Android | same design; keys in Keystore; same enrolment and recovery |

## 7. Residual risks to state honestly

- **The server delivers the web client.** A compromised server can serve JavaScript that exfiltrates keys at the next sign-in. Mitigations: the Android app (code signed separately), a browser extension or a desktop client with signed releases, Subresource Integrity plus a published hash of each web release, and verifiable builds. Without them, web E2E protects stored data from a server **snapshot** or a database leak, not from an attacker who keeps control of the server.
- Metadata stays visible: who shares with whom, when, file sizes, access times. The audit log needs it.
- Endpoint compromise defeats any encryption.
- Usability: lost recovery codes mean lost data.

## 8. Authorization and audit still apply

Nothing about access control is removed: the server still checks roles, grants, expiries and group confirmation before returning ciphertext or envelopes, RLS still applies to every row (including envelope rows), and every fetch is still written to the hash-chained, anchored audit log. E2E only adds a second, cryptographic condition for reading. The key-transparency log reuses the existing audit anchoring, so customers can verify both "who was given access" and "which keys could read" from outside.

## 9. If it is ever built: order of work

1. Key transparency for device lists (useful even without E2E, for passkeys and sessions).
2. Android-only E2E for a document category (no web-delivery problem).
3. Recovery secret + optional escrow.
4. Web client with SRI and published release hashes.
5. Group keys and epochs.
