-- Accounts are created by invitation (THREATS.md S18). The admin gives an
-- email, a role and maybe an end date; the person chooses their own name and
-- password through an emailed link. Until then the account is INVITED: every
-- access check in the app and the database asks for status = 'ACTIVE', so an
-- invited account can do nothing.
--
-- A new enum value cannot be used in the transaction that adds it, so the
-- rule that mentions INVITED is in the next migration.
ALTER TYPE "UserStatus" ADD VALUE 'INVITED';

-- When the person first chose a password. Null only for an invitation never
-- accepted, so reactivating such an account returns it to INVITED rather
-- than making it ACTIVE with a password nobody knows. Existing accounts (and
-- rows inserted outside the invite path, like the seed) count as activated.
ALTER TABLE "users" ADD COLUMN "activated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP;
UPDATE "users" SET "activated_at" = "created_at";
ALTER TABLE "users" ADD CONSTRAINT "users_active_was_activated" CHECK ("status" <> 'ACTIVE' OR "activated_at" IS NOT NULL);

-- Invitation links reuse the reset-link table rather than a copy of it: the
-- same guarantees (only a SHA-256 stored, one use, expiry, no DELETE, same
-- grants) with one column saying which flow a link belongs to. Each flow
-- accepts only its own links.
CREATE TYPE "LinkPurpose" AS ENUM ('RESET', 'INVITE');
ALTER TABLE "password_reset_tokens" ADD COLUMN "purpose" "LinkPurpose" NOT NULL DEFAULT 'RESET';
