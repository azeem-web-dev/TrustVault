-- Password reset by email link (THREATS.md S16, S17).
-- Only a SHA-256 of each link is stored, so a database reader cannot use
-- one. A link works once, expires (30 minutes by default), and asking for a
-- new one cancels the old. requested_by is set when an admin sent it.
CREATE TABLE "password_reset_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" BYTEA NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "requested_by" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");
-- No DELETE: used and expired links stay as part of the account's history.
GRANT SELECT, INSERT, UPDATE ON "password_reset_tokens" TO trustvault_app;
