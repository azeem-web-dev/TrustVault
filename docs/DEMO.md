# Five-minute demo

Recorded at https://vault.rayyanazeem.cloud with two browser windows side by side: a normal one for the owner and the admin, a private one for Victor. Demo logins and the admin authenticator secret are in the README. Every step below uses a feature that exists and is tested; the test is named so the claim can be checked.

Video: https://drive.google.com/file/d/1Kq3-oORDJoaL3NhjghYuXnQi9WVIaJjf/view?usp=drivesdk

## Before recording

Prepare two files on the desktop:

```bash
cp any-real.pdf "Q4 forecast.pdf"                                     # a genuine PDF
printf '<html><script>alert(1)</script></html>' > invoice.pdf         # HTML pretending to be a PDF
```

## The script

| Time | Show | Say | Proven by |
|---|---|---|---|
| 0:00–0:20 | Login page, then the README roles table | "TrustVault: the wrong person can never read a file, and the record proves who did. Four roles: admin, owner, viewer, external. Admins manage people; they get no access to documents." | `auth.test.ts` |
| 0:20–0:50 | **Olivia** signs in. Upload *Q4 forecast.pdf*, category *Finance*. Then upload *invoice.pdf* | "The type is decided from the bytes, not the name. This 'PDF' is an HTML page with a script, so it is refused, and the refusal is recorded with the file's hash." | `documents.test.ts` upload section; `upload-sanitize.test.ts` (one audit row per refused upload) |
| 0:50–1:20 | Search box: *forecast*. Then the filters: owner *Oscar*, category *HR*, a date range of today | "Search by name, owner, category and date. It only ever returns what you can open, and the counts never include anything else." | `documents.test.ts` "q matches the title…", "owner matches…", "category matches…", "from/to bound the upload date", "search never returns, counts or hints…" |
| 1:20–1:45 | *Q4 forecast* → Access → share with **Victor** at **Download** | "Permissions are per document, to a named person, at View only, Download, Edit or Manage. Folders never give access." | `documents.test.ts` "READ: can view and download…" |
| 1:45–2:20 | **Victor** (private window) sees *Q4 forecast*. He pastes the URL of *Salary bands 2026* (copied from Olivia's window): "does not exist, or you do not have access". Back to Olivia → *Salary bands 2026* → History: Victor's attempt, **DENIED**, with the reason | "An outsider gets the same 404 as for a document that does not exist, so he cannot even learn it is there. The server decides on every route, and the refusal is evidence." | `documents.test.ts` "every document route returns 404 to a user with no grant, and each refusal is audited", "a document id that does not exist looks exactly like one you cannot see" |
| 2:20–2:50 | Victor has *Q4 forecast* open. Olivia clicks **Remove** on Victor. Victor clicks **Download** in his already-open tab: refused | "Revoking deletes the grant. There are no tokens to wait out and nothing cached: the very next request fails." | `documents.test.ts` "revoking a grant: the very next request is refused, and the attempt is audited"; `download-order.test.ts` |
| 2:50–3:15 | Olivia shares *Q4 forecast* with Victor again, at **View only**. Victor opens it: watermarked pages with his email and a trace code. He tries the download address (`/api/documents/<id>/download`): refused | "View only means pages drawn by the server, never the file, by any route; the database refuses too." | `view-only.test.ts` "a VIEW grantee can find, open and page through a document, but every route to the original is refused", "the database alone refuses the original to a VIEW grantee" |
| 3:15–4:00 | **Ada** (admin) signs in with the authenticator code. Audit log → "Permission changes" filter → **Verify integrity**: intact, with the number of events and signed checkpoints. Then paste a document URL: refused | "Every event is hash-chained by the database, which refuses edits even from the table owner; a separate key service signs a checkpoint every minute and it goes to Sigstore's public log. And the admin, who can see all of this, cannot open a single document." | `admin-mfa.test.ts` "lists document activity and permission changes…", "verifies the chain and signed checkpoints"; `revocation-holes.test.ts` (admins never read) |
| 4:00–4:35 | Olivia → *Salary bands 2026* → **Show suggestions**: Victor ("you shared 1 other HR document with them"). Confirm. History shows two rows: the suggestion, then the grant marked *confirmed by owner*. Then remove the grant again | "Suggestions are a simple heuristic over who you already shared that category with; there is no AI model. They never grant anything: the owner confirms, and both steps are recorded." | `documents.test.ts` "suggests people from similar documents, grants nothing, and audits the suggestion" |
| 4:35–5:00 | README "Known limitations" | "What is not finished: one server; the last minute or two of the audit log before a compromise is not yet public; admin impersonation through a reset is detected, not prevented; screenshots of view-only pages in a browser can only be reported, not blocked; the demo protection is built but not switched on yet." | docs/WRITEUP.md "What is not finished" |

## Recording checklist

- [ ] Demo state is the seed: Victor sees exactly three documents, *Salary bands 2026* has no grants, no MFA policy beyond ADMIN, no role rules. If not, run the demo reset (below) first.
- [ ] Two windows, same size, browser zoom 110–125%, bookmarks bar and extensions hidden, notifications off.
- [ ] Authenticator code for Ada ready (`oathtool --totp -b <secret from README>`); a code works once, so generate it just before 3:15.
- [ ] Files *Q4 forecast.pdf* and *invoice.pdf* on the desktop.
- [ ] Nothing secret on screen: no terminal with `/etc/trustvault`, no SSH session, no password manager.
- [ ] 1080p, microphone level checked, one take per row is fine; cut between rows.
- [ ] Afterwards: remove the shares you added (or run the reset), trash *Q4 forecast*, and make sure the video link in the README still opens (done for the 2026-11-08 recording).

## Keeping the shared demo usable

Every visitor signs in with the same published accounts, including the admins (their authenticator secrets are in the README). "The same attempts for everyone" means one visitor must not change what the next one sees. Two things protect that.

**The protected accounts** (THREATS.md I8), always on: demo accounts cannot be deactivated, demoted, renamed or have their password or second factor changed, enforced in the API and in the database.

**`DEMO_MODE=true`** (THREATS.md I15), in `/etc/trustvault/api.env`:

- invitation, password-reset and sign-in-link emails are written to the audit log (`reason: demo_mode`) and never sent, and no link is created;
- an MFA policy covering any role other than ADMIN is refused with `403 {"code":"demo_mode"}` (the protected demo accounts cannot enrol a factor, so it would lock them out), and so is any role-wide time or network rule (every non-admin role has a demo account);
- both refusals are recorded.

Invitations are also limited for everyone, demo or not: 20 per admin and 60 in total per hour (`INVITE_LIMIT_PER_ADMIN`, `INVITE_LIMIT_GLOBAL`; THREATS.md I16).

**The demo reset** puts back what visitors can still change: `infra/server/demo-reset.sh` (logic in `apps/api/src/cli/demo-reset.ts`), run as the schema owner in one transaction. It restores

- the MFA policy (ADMIN only) and removes role-wide rules;
- the *Finance* and *Engineering* groups' members, and takes demo accounts out of any other group;
- each seed document's owner (undoing a transfer), status (undoing the trash) and grants (exactly the seed's, with the external's 30-day expiry restarted);
- no folders for demo accounts.

It never deletes audit rows, documents or files, and leaves documents that are not in the seed where they are. It adds one `demo.reset` audit row listing what it changed. `demo-reset.test.ts` runs the real seed, breaks all of the above, resets, and checks the result and that the audit log grew by exactly one row.

Run it by hand:

```bash
sudo bash /opt/trustvault/app/infra/server/demo-reset.sh
```

Install the 4-hourly timer:

```bash
sudo install -m 0644 /opt/trustvault/app/infra/systemd/trustvault-demo-reset.service /opt/trustvault/app/infra/systemd/trustvault-demo-reset.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now trustvault-demo-reset.timer
```

**Status on 2026-11-08:** all of this is in the repository and tested in CI, but `DEMO_MODE` is **not** switched on in production and the timer is **not** installed. Both are the owner's decision. Until then, protected accounts are the only protection, and anything else a visitor changes stays until someone resets it.
