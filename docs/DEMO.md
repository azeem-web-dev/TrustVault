# Five-minute demo script

Record at https://vault.rayyanazeem.cloud with two browser windows side by side (or one normal, one private). Demo logins are in the README.

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | Login page | "TrustVault: the wrong person can never read a file, and the record proves who did. Two locks on every document, an audit trail the database itself protects, and revocation that works on the next request." |
| 0:20–1:00 | **Olivia** (owner): document list, open *Salary bands 2026* → "Who has access" shows only her. Open *Offer letter* → shared with Victor, READ. | "Olivia owns five documents. Each one shows exactly who has access and at what level." |
| 1:00–1:40 | **Victor** (viewer, second window): his list shows 3 documents. Search "Salary": nothing. Paste the Salary bands URL: "does not exist, or you do not have access". | "Victor cannot find, count or open what was not shared with him, and he can't tell whether it exists." |
| 1:40–2:20 | Victor downloads *Offer letter*. Olivia clicks **Remove** on Victor's access. Victor clicks Download again: refused. | "Revocation is a row delete; both locks read grants live. No token, no cache: the next request fails." |
| 2:20–2:50 | Olivia → document **History**: Victor's download, the revoke, and his refused attempt with the reason. | "Refused attempts are evidence too." |
| 2:50–3:40 | **Admin**: sign in, enter the authenticator code (admins must have a second factor). Audit log → "Permission changes" filter → **Verify integrity** → "intact, N events, M signed checkpoints". Click **Export evidence bundle**, run `node tools/verify-audit.mjs bundle.json --key <production key from the README>` in a terminal → INTACT. Edit one line in the JSON, run again → TAMPERED. | "The database chains every event by hash and refuses edits, even from the table owner. A separate key service signs checkpoints. Anyone can verify an export offline." |
| 3:40–4:10 | Admin → **Alerts**: "victor tried to reach a document after access was revoked". Admin tries to open a document: refused; break-glass needs a reason and a **second** admin: ask as Ada, approve as Ben (`admin2@demo.com`, Approvals page), then Ada opens it once. | "Admins manage people, not documents. Emergency access needs two admins, lasts one hour, shows watermarked pages only (no download), is alerted and visible to the owner." |
| 4:10–4:40 | Terminal: `node tools/mutation-check.mjs` (55 rules) and its last report (docs/MUTATION_REPORT.md): each removal and the test that caught it. | "I removed every authorisation rule one at a time; a test fails each time, including the database's own rules." |
| 4:40–5:00 | THREATS.md headings | "Everything I defended, how I know it holds, and what I knowingly left: no anonymous links, no previews, no folder inheritance, no end-to-end encryption, and root on the server is out of scope." |
