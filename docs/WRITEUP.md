# TrustVault write-up

Live: https://vault.rayyanazeem.cloud · Code: https://github.com/azeem-web-dev/TrustVault

## What I built

A document platform for confidential files: salary letters, contracts, board minutes. The wrong person cannot reach a document by any route, and the record proves who did.

- **Accounts:** four roles (admin, document owner, viewer, external), server-side sessions, Argon2id passwords, lockout and rate limits. Admins must use a second factor (authenticator app or passkey); anyone else can enrol one.
- **Documents:** upload (type checked from the bytes), versions, folders, trash and restore, permanent delete, ownership transfer. Search by name, owner, category and date.
- **Permissions:** per-document grants of READ, EDIT or MANAGE to named people or groups, optional expiry, revoke. External people get READ only, always with an expiry.
- **Encryption at rest:** a random AES-256-GCM key per file version, wrapped by a separate key service (Rust) running as its own Linux user. The API never holds the master key.
- **Audit trail:** every upload, view, download, edit, deletion, permission change, sign-in and **refused attempt**. The database itself hash-chains the log and refuses edits and deletions. The key service signs checkpoints every 10 minutes. Admins can verify the chain in one click or export a bundle that a dependency-free script verifies offline.
- **Admin view:** filterable activity, integrity verification, alerts (repeated refusals, attempts after revocation, bulk downloads, external sharing, break-glass, blocked sign-ins, integrity failures), users, groups, and audited break-glass access.
- **Access suggestions:** for a document, suggests people you shared similar documents with. Suggestions never grant; you confirm each one, and both are audited.

## The permission model, in my own words

There are two kinds of permission and they never mix.

**Account roles** decide what kind of user you are: admins manage people and read the audit log, owners can upload, viewers work with what they are given, externals can only read what they are given, until a date. **The admin role gives no access to any document.** An admin who must read a document in an emergency uses break-glass: a written reason, one hour, read-only. It is raised as an alert and appears in the document's history for its owner.

**Document grants** decide what you can do with one document: READ (open, download), EDIT (also rename, upload new versions), MANAGE (also share, revoke, see who has access and the history), and the owner, who can also move, delete, restore and transfer. Grants go to a named person or a group. Nobody can give more than they have: MANAGE can share READ and EDIT; only the owner can give MANAGE; you cannot change your own access. Folders only organise. They never give access, because "I gave them the folder for one file and they could see forty" is the first problem in the brief.

**Where the decision is made.** Every route that names a document calls `access.require()` in `apps/api/src/documents/access.ts` before anything else. It loads raw facts and runs `evaluate()`, a pure function: deny by default, ignore expired grants, ignore group grants for externals, cap externals at READ, hide trashed documents from everyone but the owner, then compare the level to what the action needs. A refusal is a 404 (the same as a document that does not exist) plus an audit row with the reason.

**What happens if that line is removed.** Postgres row-level security is the second lock. The API connects as a database role that owns nothing, sets `app.user_id` for each transaction, and every document table has policies based on `tv_doc_level()`, the same rule written separately in SQL. Remove the download check and the version and file rows are still invisible: the request still fails. But the refusal is no longer audited, so a test fails (`every document route returns 404 … and each refusal is audited`). The two locks are also tested separately: `access.unit.test.ts` (decide alone), `rls.test.ts` (the database alone) and `search-filter.test.ts` (the search filter alone). `tools/mutation-check.mjs` removes 22 rules one at a time and shows every removal caught.

**Taking access away.** Revoking deletes the grant row. Both locks read grants and group membership live on every request, and nothing caches permissions. Sessions are random tokens looked up in the database on every request, not JWTs, so deactivating someone, changing their role or password, or letting an external account expire ends their session on the next request. The cost: a database lookup per request, and no "offline" tokens. I think that is the right trade for this product.

## What I deliberately did not build

| Not built | Why |
|---|---|
| Anonymous share links | A link works for whoever holds it, and revoking means finding every copy. Outsiders get named EXTERNAL accounts with an expiry instead. |
| Folder inheritance | It is exactly the "one folder, forty files" problem. |
| End-to-end encryption | The server could no longer check uploads, search or audit. The threat it covers (full server compromise) is accepted and written down. |
| File previews | Rendering untrusted files server-side is a large attack surface. Files are only downloaded, as attachments, under a sandbox CSP. |
| Auth0 / Keycloak / JWTs | Tokens stay valid until they expire, which breaks "revoke works immediately". |
| Open Policy Agent | A second language and a network hop for the decision I most need to explain; `decide()` plus RLS gives two independent locks instead. |
| Kubernetes, SIEM, cloud HSM | Out of proportion for one server. A sandboxed systemd service and the alerts page cover what matters at this size. |

## How I used AI, and where it was wrong

I used Claude (Claude Code) to plan, write most of the code, write tests and deploy. I directed the design, reviewed what it produced against the brief's three rules, and made it prove each rule with a test. ChatGPT was used at the start for a stack suggestion that I mostly rejected.

The full log is in [PROMPTS.md](../PROMPTS.md). The mistakes that mattered:

1. **The suggested stack would have broken immediate revocation:** Auth0/Keycloak issue tokens that live until expiry.
2. **A grants policy hid group grants from group members**, so "shared with me" search would have missed every group-shared document.
3. **Row-level security blocked every upload**, because Postgres checks inserted rows against the SELECT policy and the access function could not see the new row yet.
4. **The audit export sorted text instead of numbers**, so every honest export would have looked tampered with. The offline verifier caught it.
5. **A check order leaked:** "you already own this" was answered before "not found".
6. **The retention job could delete without an audit record.**
7. **Upload validation accepted a renamed binary as text.**
8. **Two backup checks and one search layer had no test that would notice their removal.** Found by reading the mutation plan before running it; fixed with direct-to-database tests.
9. **Login timing leaked which emails have accounts.** The design said it was equalised; when I finally measured it, a wrong password on a real account was 40 ms slower than an unknown email (one extra database write), and a simple threshold told them apart 78% of the time. The first fix (wrap the writes in a transaction) made it worse, 152 ms and 99%, because each round trip to the database was the cost, not the commit. The working fix makes the counter, lock and audit row one SQL statement, and pads every failed login to 450 ms. Measured again: chance.

## What is not finished

These were open gaps in the first version and are now built and tested: the outside witness for the audit chain (THREATS.md L8), malware scanning of uploads (U6), the login timing measurement (S2), automated encrypted backups of the database and master key (K4), and an end-to-end passkey test (S12). What is still open:

- **Backups stay on server 136.** They are encrypted to a key that is not on the server, and tested by restoring one, but losing the machine loses them. Copying them off-site was offered and declined for now; it is one `scp` (docs/RESTORE.md).
- **The newest ~20 minutes of audit events** are protected by the hash chain and signatures, but not yet by the outside witness (L5).
- **Signature-based malware scanning** does not catch brand-new malware. Files are still never opened on the server.
- **Passkeys in a real browser.** The full WebAuthn ceremony is tested with a software authenticator that produces real keys and bytes; I have not run it with a phone or security key against the live site.
- **Demo video:** the script is in [docs/DEMO.md](DEMO.md); the recording is mine to make.
- **One server.** No database replication.
