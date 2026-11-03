-- Sign-in confirmation links (THREATS.md S19). When an account is under a
-- guessing attack, a sign-in from a device the account has not used before
-- does not get a session from the password alone: the right password emails
-- the person a one-time link that finishes signing in. The links live in the
-- same table as reset and invitation links (only a SHA-256 stored, one use,
-- expiry, same grants), marked SIGNIN. Each flow accepts only its own links.
--
-- No change to the users table: the per-account lock columns
-- (failed_login_count, locked_until) are simply no longer written at sign-in.
ALTER TYPE "LinkPurpose" ADD VALUE 'SIGNIN';
