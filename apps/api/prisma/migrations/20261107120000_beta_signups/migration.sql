-- Android beta signups: an address, kept only to email the closed-test steps.
-- No IP, no name, no link to an account. Like password_reset_tokens this holds
-- no document data, so it has grants but no row-level security. The app role
-- may add an address, read it back and bump the send counters; it can never
-- delete a row or rewrite an address (removal on request is done by the
-- schema owner, see the privacy page).
CREATE TABLE "beta_signups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_emailed_at" TIMESTAMPTZ(6),
  "email_count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "beta_signups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "beta_signups_email_lower" CHECK ("email" = lower("email") AND char_length("email") BETWEEN 3 AND 254)
);
CREATE UNIQUE INDEX "beta_signups_email_key" ON "beta_signups"("email");
GRANT SELECT, INSERT ON "beta_signups" TO trustvault_app;
GRANT UPDATE ("last_emailed_at", "email_count") ON "beta_signups" TO trustvault_app;
