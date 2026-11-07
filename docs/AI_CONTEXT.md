# The context the AI gets each session

What I give Claude (Claude Code) at the start of a working session, word for word where it is fixed text. PROMPTS.md links here; it records what happened with it.

## 1. Always

The problem statement (pasted in full), then these files to read before changing anything: `README.md`, `THREATS.md`, `PROMPTS.md`, `docs/WRITEUP.md`, `docs/API.md`, `docs/PLAN.md`.

Then the standing rules:

> Every route that names a document calls `access.require()` first, before any other check or message. Never cache permissions. Every allow and deny writes an audit row; allows in the same transaction as the action, denials outside it. Run document queries only through `prisma.asUser()`. New authorisation code is not done until a test fails when the check is removed. PROMPTS.md records only what actually happened.

(The first version, used from 2026-11-01, was: *"Every endpoint must go through decide(); never cache permissions; every allow and deny writes an audit row in the same transaction."* It changed when denials moved outside the transaction so a rolled-back request still leaves its refusal on record.)

## 2. Ground rules for changes (from 2026-11-07)

> Small honest commits. One logical change each. Never amend pushed commits, rebase, force-push or change dates.
> No new subsystems. The brief says "a smaller system with a permission model that holds beats a larger one with a hole in it". Prefer simplifying.
> Every behaviour change gets a test that fails without it. For any authorisation change, add a row to tools/mutation-check.mjs and run it.
> Never claim something works unless you ran it. If you can't finish something, write it under "What is not finished" in docs/WRITEUP.md.
> Log this session in PROMPTS.md in the existing format (Asked / Got / What was wrong / What I did instead / Commit link), including your own mistakes that I corrected.
> Ask me before touching production, the live database, secrets, or deleting a file over 300 lines.
> Leave the demo documents alone. Documents visible to the demo accounts are sample test data. Don't flag, delete or change them.
> Keep the repository public. The brief requires it.

## 3. When work is split across parallel agents

Each agent gets the same written brief, so they stay consistent and do not step on each other. The one used for the security hunt (2026-11-03), in substance:

> Authorised defensive review of our own app; local only, never touch production. Read the problem statement, docs/PLAN.md and THREATS.md first. You own one area, one throwaway database and one git worktree; attack only your area, against your local build. The three guarantees you are trying to break: (1) a document is reachable only by someone granted it, through any route, server-decided every time; (2) who reached it is provable afterwards, including refusals, from a log that cannot be quietly altered; (3) revocation works immediately. Every finding is confirmed with a live request before it is fixed, gets a test that fails without the fix, and a THREATS.md row.

## 4. Environment facts given with the brief (2026-11-08 session)

Where the clone is, that production must not be deployed to or touched, that local database credentials do not work on this PC (so CI is the source of truth for test counts, and which numbers came from CI must be said), and that the Android signing key never enters git. The full session prompt is summarised in PROMPTS.md, 2026-11-08.
