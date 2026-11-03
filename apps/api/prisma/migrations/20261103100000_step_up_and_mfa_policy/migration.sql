-- Step-up re-verification (THREATS.md S20): when a second factor was last
-- presented in each session. Sessions that are already MFA level were
-- created at the moment of verification, so that is their starting value.
ALTER TABLE "sessions" ADD COLUMN "mfa_verified_at" TIMESTAMPTZ(6);
UPDATE "sessions" SET "mfa_verified_at" = "created_at" WHERE "auth_level" = 'mfa';

-- Per-role second-factor policy (THREATS.md S21). One row, never deleted;
-- ADMIN can never be taken out, even by a direct UPDATE.
CREATE TABLE "app_settings" (
  "id" SMALLINT NOT NULL DEFAULT 1,
  "mfa_required_roles" "Role"[] NOT NULL DEFAULT ARRAY['ADMIN']::"Role"[],
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by_id" UUID,
  CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "app_settings_single_row" CHECK ("id" = 1),
  CONSTRAINT "app_settings_admin_needs_mfa" CHECK ('ADMIN' = ANY ("mfa_required_roles"))
);
INSERT INTO "app_settings" ("id") VALUES (1);
-- No INSERT or DELETE: the app can only change the one row.
GRANT SELECT, UPDATE ON "app_settings" TO trustvault_app;
