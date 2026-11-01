-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OWNER', 'VIEWER', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('ALLOWED', 'DENIED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "password_hash" TEXT NOT NULL,
    "password_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "access_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by_id" UUID,
    "deactivated_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "csrf_token" TEXT NOT NULL,
    "auth_level" TEXT NOT NULL DEFAULT 'password',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "seq" BIGINT NOT NULL DEFAULT 0,
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "actor_email" TEXT,
    "action" TEXT NOT NULL,
    "outcome" "AuditOutcome" NOT NULL,
    "reason" TEXT,
    "target_type" TEXT,
    "target_id" TEXT,
    "document_id" UUID,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "details" JSONB,
    "prev_hash" BYTEA NOT NULL DEFAULT '\x'::bytea,
    "hash" BYTEA NOT NULL DEFAULT '\x'::bytea,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_id_key" ON "audit_events"("id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_hash_key" ON "audit_events"("hash");

-- CreateIndex
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_occurred_at_idx" ON "audit_events"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_document_id_occurred_at_idx" ON "audit_events"("document_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_action_occurred_at_idx" ON "audit_events"("action", "occurred_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- Hand-written below this line: privileges, constraints, audit chain.
-- =====================================================================

-- ---------- Integrity rules the database enforces on its own ----------
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalised" CHECK ("email" = lower(btrim("email")) AND "email" <> '');
ALTER TABLE "users" ADD CONSTRAINT "users_external_needs_expiry" CHECK ("role" <> 'EXTERNAL' OR "access_expires_at" IS NOT NULL);
ALTER TABLE "users" ADD CONSTRAINT "users_deactivated_has_time" CHECK (("status" = 'DEACTIVATED') = ("deactivated_at" IS NOT NULL));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_is_sha256" CHECK (octet_length("token_hash") = 32);
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- ---------- What the running app (trustvault_app) may do ----------
-- Granted here, not only in provisioning, because a schema reset recreates
-- "public" and would silently drop the grant.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO trustvault_app;
-- Users are never hard-deleted: they are deactivated, so the audit record
-- of who did what keeps pointing at a real account.
GRANT SELECT, INSERT, UPDATE ON "users" TO trustvault_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sessions" TO trustvault_app;
-- Audit: insert and read only. No UPDATE, DELETE or TRUNCATE privilege.
GRANT SELECT, INSERT ON "audit_events" TO trustvault_app;

-- ---------- Audit chain ----------
-- Each event's hash = SHA-256(previous hash || canonical bytes of this event).
-- The trigger, not the app, assigns seq, occurred_at, prev_hash and hash.
CREATE SEQUENCE "audit_seq" AS bigint MINVALUE 1 NO CYCLE;

-- Unambiguous field encoding: NULL -> "~", value -> "<utf8 byte length>:<value>".
-- A length prefix means no value can be shifted into the next field without
-- changing the bytes, which a plain separator would not guarantee.
CREATE FUNCTION audit_field(v text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN v IS NULL THEN '~'
              ELSE octet_length(convert_to(v, 'UTF8'))::text || ':' || v END
$$;

CREATE FUNCTION audit_canonical(e "audit_events") RETURNS bytea
LANGUAGE sql STABLE AS $$
  SELECT convert_to(
       audit_field('tv-audit-v1')
    || audit_field(e."seq"::text)
    || audit_field(e."id"::text)
    || audit_field(to_char(e."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    || audit_field(e."actor_id"::text)
    || audit_field(e."actor_email")
    || audit_field(e."action")
    || audit_field(e."outcome"::text)
    || audit_field(e."reason")
    || audit_field(e."target_type")
    || audit_field(e."target_id")
    || audit_field(e."document_id"::text)
    || audit_field(e."ip")
    || audit_field(e."user_agent")
    || audit_field(e."request_id")
    || audit_field(e."details"::text),
    'UTF8')
$$;

-- SECURITY DEFINER: runs as the schema owner, so the app role needs no
-- rights on audit_seq and cannot call setval() to rewind it.
CREATE FUNCTION audit_chain_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  prev bytea;
BEGIN
  -- Under REPEATABLE READ the lookup below could miss a row committed by a
  -- concurrent writer and fork the chain. Refuse rather than risk it.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'audit events must be written under READ COMMITTED';
  END IF;
  -- One writer at a time, held until commit, so chain order = commit order.
  PERFORM pg_advisory_xact_lock(7310001);
  NEW."seq"         := nextval('audit_seq');
  NEW."occurred_at" := clock_timestamp();
  SELECT "hash" INTO prev FROM "audit_events" ORDER BY "seq" DESC LIMIT 1;
  NEW."prev_hash"   := coalesce(prev, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea);
  NEW."hash"        := sha256(NEW."prev_hash" || audit_canonical(NEW));
  RETURN NEW;
END
$$;

CREATE TRIGGER "audit_events_chain" BEFORE INSERT ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_chain_before_insert();

-- Two events can never claim the same predecessor: the chain cannot fork.
CREATE UNIQUE INDEX "audit_events_prev_hash_key" ON "audit_events"("prev_hash");

-- Belt and braces on top of the missing privileges: even the table owner
-- gets an error on UPDATE / DELETE / TRUNCATE. (A superuser can still drop
-- the trigger; signed checkpoints and the off-server export catch that.)
CREATE FUNCTION audit_block_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER "audit_events_no_update_delete" BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_block_change();
CREATE TRIGGER "audit_events_no_truncate" BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_block_change();

-- Recomputes every hash in order. Returns the first seq that does not match
-- (NULL if the whole chain is intact) and how many events were checked.
CREATE FUNCTION audit_verify(OUT first_bad_seq bigint, OUT checked bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r "audit_events";
  expected_prev bytea := '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
BEGIN
  checked := 0;
  FOR r IN SELECT * FROM "audit_events" ORDER BY "seq" LOOP
    IF r."prev_hash" <> expected_prev OR r."hash" <> sha256(r."prev_hash" || audit_canonical(r)) THEN
      first_bad_seq := r."seq";
      RETURN;
    END IF;
    expected_prev := r."hash";
    checked := checked + 1;
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION audit_verify() TO trustvault_app;
REVOKE ALL ON FUNCTION audit_chain_before_insert() FROM PUBLIC;
