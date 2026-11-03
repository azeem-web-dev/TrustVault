# Incident tabletop exercises

A tabletop is a rehearsal on paper: a facilitator reads out what happens, the team says what they would do, and nobody touches production. The goal is to find gaps in [INCIDENT.md](INCIDENT.md) and [BACKUP_DR.md](BACKUP_DR.md) before a real incident does.

**Cadence:** one scenario every quarter, rotating; all three in the first month. **Time:** 60–90 minutes each. **People:** the incident lead (owner), a facilitator (anyone else: a friend, a reviewer, a colleague; with one person, read the injects only after answering the previous one), and whoever would actually be called. **Output:** the filled-in record at the end, saved with the incident logs, and every gap turned into a dated action.

Rules: answer with what you would do **now, with the tools that exist today**, not with what is on a branch. When an answer is "I would look at X", say exactly where X is. The facilitator times each answer that has a deadline (snapshot in 4 minutes, CERT-In in 6 hours).

---

## Scenario 1: "The witness failed at 02:10"

*Tests: root-compromise playbook, outside records, evidence, rebuild, notification clock.*

**Inject 1 (02:10 IST, Saturday).** GitHub emails: *"Audit witness: failed"*. The log says: `checkpoint 18422 changed since it was witnessed`.
- What do you do in the first 5 minutes? Where is the incident log? Do you log in to the server?
- Expected: declare SEV1 (unexplained witness alarm), open the log, **don't** SSH in yet, snapshot from hPanel, check the last good `checkpoints.jsonl` line and Rekor.

**Inject 2 (02:18).** Rekor still has the original checkpoint 18422 (log index noted in `public-log.jsonl`). The server's `/api/witness/checkpoints` now shows a different head hash for 18422, signed with the **real** key.
- What does this tell you? (Someone with the signing key — i.e. root, or keyd's master key — rewrote history before seq 18422 and re-signed it.) What can't they have changed?
- Which documents can you say were not read? (None with certainty; THREATS I6.)

**Inject 3 (02:25).** You find an unknown key in `/root/.ssh/authorized_keys` (from the evidence commands, or the snapshot).
- Containment choice: firewall-only vs power off? What breaks for the other services on the shared VPS, and who do you tell?
- Which credentials do you rotate first and from where? (INCIDENT §6 1–4 from the PC; the rest on the rebuilt server.)

**Inject 4 (03:30).** The nightly backup timer fires on the compromised server.
- Is tonight's backup trustworthy? Which backup will you restore from, and how do you choose? (Before the earliest attacker activity; drill it first.)

**Inject 5 (07:00).** A customer emails: "We got a sign-in notice we didn't expect."
- Clock check: when did you "notice" the incident for CERT-In (6 hours)? Is the report sent? What do you tell the customer, and what do you **not** say?
- Is the master key compromised? What can and cannot be done about it today (rotation tooling not built, INCIDENT §4.5)?

**Wrap-up questions.** How long until the site is back? Where would you get a clean server? Who has the age identity, and is it reachable at 07:00 on a Saturday?

---

## Scenario 2: "An admin read the CEO's contract"

*Tests: malicious-admin playbook, break-glass and impersonation evidence, audit export verification, leaked-document handling.*

**Inject 1 (Monday 10:00).** The CEO (an OWNER) says a clause from a private contract was quoted back to her by someone in the finance team.
- Where do you look first? Which events show who received that document? (`document.download`, `admin.break_glass`, grants at the time.)

**Inject 2 (10:20).** Admin → Alerts shows `reset_then_sign_in`: admin *Raj* reset the CEO's password at 23:41 on Friday, and the CEO's account signed in at 23:44 from Raj's usual IP. The CEO says she did not ask.
- What happened? (THREATS S15: the old set-password route; detected and alerted, not prevented. The P0 fix removes it.)
- What do you do with Raj's account, and from which account? Is there a second admin?

**Inject 3 (10:40).** Raj says the audit log is fake: "the system logs whatever it wants".
- How do you prove the log was not changed afterwards? (Export a bundle, run `verify.py` and `verify-audit.mjs` with `--key --witness --rekor`; the checkpoints covering Friday night were published within a minute; VERIFY.md §1 on what this does and does not prove: it proves the record was not altered; it does not prove Raj was the human at the keyboard.)

**Inject 4 (11:00).** The contract contains personal data of two employees.
- Notification decision: confirmed or suspected? Who is the data fiduciary (the customer company) and who is the processor? Who tells whom, by when?

**Wrap-up.** Which control would have prevented this rather than detected it? (Admins cannot set passwords; two-person approval for owner account recovery: checklist item 1.) Is it tracked with a date?

---

## Scenario 3: "The PC is encrypted and the VPS is gone"

*Tests: disaster recovery without the production server, backup key custody, RTO.*

**Inject 1 (Wednesday 09:00).** Hostinger has suspended the VPS after an abuse complaint against another service on it; support says it may take 3 days. TrustVault is down.
- What is the RTO target (BACKUP_DR §2)? Can you meet it without the old server? What do you need: a new VPS, the code, a backup, the age identity, DNS access.

**Inject 2 (09:15).** Your PC shows a ransom note. `C:\Users\ridah\TrustVault-backups` and `C:\Users\ridah\TrustVault-backup-key` are encrypted.
- Where is the second copy of the age identity? (BACKUP_DR §4: if it does not exist, this is where the business ends. This inject is the reason to make it.)
- Where is a backup copy? (Object Lock bucket, if enabled; otherwise none.)

**Inject 3 (10:00).** You have a backup from the Object Lock bucket (2 days old) and the paper copy of the identity.
- Walk through the rebuild (INCIDENT §7, RESTORE.md) on a new VPS. Which secrets are new? What happens to the witness workflow after you restore a 2-day-old backup? (It fails on the lost range; BACKUP_DR §7: archive the witness log with a note.)
- What do you tell customers about the 2 lost days of documents and audit events?

**Wrap-up.** Time each step on paper against the 8-hour target. What was the slowest step? When was the last real drill (BACKUP_DR §6)?

---

## Record of the exercise

```
Scenario:            Date:            Facilitator:          Participants:
Duration:            Answers that missed a deadline:
Gaps found:          | gap | runbook section | action | owner | due |
Runbook changes made:
Next exercise (scenario, date):
```
