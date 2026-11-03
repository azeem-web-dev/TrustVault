-- Insider-extraction detection and enforcement (THREATS.md L15-L19, U9-U10,
-- S25-S26). Four things live here:
--
--   download_facts           one row per authorised download, written in the
--                            same transaction as its audit event. Rules and
--                            the hard limits read this table. The app cannot
--                            choose occurred_at (column grants), so it cannot
--                            backdate; tests insert backdated rows as owner.
--   risk_settings            admin-tunable thresholds and hard limits.
--   download_limit_overrides time-boxed, reasoned exceptions to the limits.
--   security_alerts          persistent alerts: append-only facts. Their
--   + security_alert_events  review history (acknowledge, assign, resolve,
--   + security_alert_status  reopen, escalate) is append-only too; the status
--                            table is derived from it by a trigger and the
--                            app can only read it.
--
-- Nothing here deletes or rewrites an alert: there is no UPDATE, DELETE or
-- TRUNCATE privilege, and triggers refuse them even for the table owner.

-- ---------------------------------------------------------------- facts
CREATE TABLE "download_facts" (
  "id"          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "user_id"     UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id"  UUID,
  "document_id" UUID NOT NULL,
  "version_no"  INTEGER,
  "ip"          TEXT,
  -- /24 for IPv4, /48 for IPv6: the "network" a request came from.
  "ip_prefix"   TEXT,
  "kind"        TEXT NOT NULL DEFAULT 'download' CHECK ("kind" IN ('download', 'page_view')),
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "download_facts_user_time_idx" ON "download_facts"("user_id", "occurred_at");
CREATE INDEX "download_facts_session_idx" ON "download_facts"("session_id");
CREATE INDEX "download_facts_prefix_time_idx" ON "download_facts"("ip_prefix", "occurred_at");
CREATE INDEX "download_facts_time_idx" ON "download_facts"("occurred_at");

-- The app names every column except id and occurred_at, so the time is
-- always the database's own clock. No UPDATE or DELETE.
GRANT SELECT ON "download_facts" TO trustvault_app;
GRANT INSERT ("user_id", "session_id", "document_id", "version_no", "ip", "ip_prefix", "kind") ON "download_facts" TO trustvault_app;

-- ------------------------------------------------------------- settings
CREATE TABLE "risk_settings" (
  "key"        TEXT PRIMARY KEY CHECK ("key" ~ '^[a-z_]{2,40}$'),
  "value"      NUMERIC NOT NULL CHECK ("value" > 0 AND "value" <= 100000),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_by" UUID
);
GRANT SELECT, INSERT, UPDATE ON "risk_settings" TO trustvault_app;

CREATE FUNCTION risk_settings_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."updated_at" := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER "risk_settings_stamp" BEFORE INSERT OR UPDATE ON "risk_settings"
  FOR EACH ROW EXECUTE FUNCTION risk_settings_stamp();

-- ------------------------------------------------------------ overrides
CREATE TABLE "download_limit_overrides" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "daily_limit"   INTEGER NOT NULL CHECK ("daily_limit" BETWEEN 1 AND 100000),
  "session_limit" INTEGER NOT NULL CHECK ("session_limit" BETWEEN 1 AND 100000),
  "reason"        TEXT NOT NULL CHECK (length(btrim("reason")) >= 20 AND length("reason") <= 500),
  "granted_by"    UUID NOT NULL REFERENCES "users"("id"),
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at"    TIMESTAMPTZ(6) NOT NULL,
  "revoked_at"    TIMESTAMPTZ(6),
  "revoked_by"    UUID REFERENCES "users"("id"),
  -- Nobody raises their own limit.
  CONSTRAINT "download_limit_overrides_not_self" CHECK ("granted_by" <> "user_id")
);
CREATE INDEX "download_limit_overrides_user_idx" ON "download_limit_overrides"("user_id", "expires_at");
GRANT SELECT, INSERT ON "download_limit_overrides" TO trustvault_app;
GRANT UPDATE ("revoked_at", "revoked_by") ON "download_limit_overrides" TO trustvault_app;

-- The database sets the start time and caps the length (14 days), like
-- break-glass; a revoke happens once and changes nothing else.
CREATE FUNCTION download_limit_overrides_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."created_at" := now();
    NEW."revoked_at" := NULL;
    NEW."revoked_by" := NULL;
    IF NEW."expires_at" <= now() THEN
      RAISE EXCEPTION 'an override must end in the future' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."expires_at" > now() + interval '14 days 1 minute' THEN
      RAISE EXCEPTION 'an override lasts at most 14 days' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'override already revoked' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revoked_at" IS NULL OR NEW."revoked_by" IS NULL
     OR (NEW."id", NEW."user_id", NEW."daily_limit", NEW."session_limit", NEW."reason", NEW."granted_by", NEW."created_at", NEW."expires_at")
        IS DISTINCT FROM (OLD."id", OLD."user_id", OLD."daily_limit", OLD."session_limit", OLD."reason", OLD."granted_by", OLD."created_at", OLD."expires_at") THEN
    RAISE EXCEPTION 'an override can only be revoked' USING ERRCODE = 'check_violation';
  END IF;
  NEW."revoked_at" := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER "download_limit_overrides_guard" BEFORE INSERT OR UPDATE ON "download_limit_overrides"
  FOR EACH ROW EXECUTE FUNCTION download_limit_overrides_guard();

-- --------------------------------------------------------------- alerts
CREATE TABLE "security_alerts" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "rule"            TEXT NOT NULL CHECK ("rule" ~ '^[a-z_]{2,60}$'),
  "category"        TEXT NOT NULL CHECK ("category" IN ('extraction', 'access', 'auth', 'session', 'integrity', 'policy', 'system')),
  "severity"        TEXT NOT NULL CHECK ("severity" IN ('critical', 'high', 'medium', 'low', 'info')),
  -- 4 critical .. 0 info, set by the trigger, for sorting.
  "severity_rank"   SMALLINT NOT NULL DEFAULT 0,
  -- Same key = same alert: the second insert is a no-op (deduplication).
  "dedup_key"       TEXT NOT NULL UNIQUE CHECK (length("dedup_key") <= 400),
  -- No foreign keys: an alert outlives the account or document it names.
  "subject_user_id" UUID,
  "subject_email"   TEXT,
  "document_id"     UUID,
  "session_id"      UUID,
  "observed"        NUMERIC,
  "threshold"       NUMERIC,
  "window_start"    TIMESTAMPTZ(6),
  "window_end"      TIMESTAMPTZ(6),
  "message"         TEXT NOT NULL CHECK (length("message") <= 1000),
  "details"         JSONB,
  -- The audit event that caused it, when there is one.
  "audit_seq"       BIGINT
);
CREATE INDEX "security_alerts_rank_time_idx" ON "security_alerts"("severity_rank" DESC, "created_at" DESC, "id" DESC);
CREATE INDEX "security_alerts_time_idx" ON "security_alerts"("created_at" DESC);
CREATE INDEX "security_alerts_subject_idx" ON "security_alerts"("subject_user_id", "created_at");
CREATE INDEX "security_alerts_document_idx" ON "security_alerts"("document_id", "created_at");

CREATE TABLE "security_alert_status" (
  "alert_id"       UUID PRIMARY KEY REFERENCES "security_alerts"("id"),
  "status"         TEXT NOT NULL CHECK ("status" IN ('open', 'acknowledged', 'assigned', 'resolved')),
  "assignee_id"    UUID,
  "assignee_email" TEXT,
  "resolution"     TEXT,
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "security_alert_status_status_idx" ON "security_alert_status"("status");

CREATE TABLE "security_alert_events" (
  "id"             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "alert_id"       UUID NOT NULL REFERENCES "security_alerts"("id"),
  "at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "action"         TEXT NOT NULL CHECK ("action" IN ('acknowledge', 'assign', 'resolve', 'reopen', 'comment', 'escalate')),
  "status_after"   TEXT NOT NULL DEFAULT 'open' CHECK ("status_after" IN ('open', 'acknowledged', 'assigned', 'resolved')),
  "actor_id"       UUID,
  "actor_email"    TEXT,
  "assignee_id"    UUID,
  "assignee_email" TEXT,
  "resolution"     TEXT CHECK ("resolution" IN ('true_positive', 'false_positive', 'benign', 'duplicate')),
  "note"           TEXT CHECK (length("note") <= 2000)
);
CREATE INDEX "security_alert_events_alert_idx" ON "security_alert_events"("alert_id", "id");

GRANT SELECT, INSERT ON "security_alerts" TO trustvault_app;
GRANT SELECT ON "security_alert_status" TO trustvault_app;
GRANT SELECT ON "security_alert_events" TO trustvault_app;
GRANT INSERT ("alert_id", "action", "actor_id", "actor_email", "assignee_id", "assignee_email", "resolution", "note") ON "security_alert_events" TO trustvault_app;

-- New alert: the database stamps the time and rank and opens its status.
CREATE FUNCTION security_alerts_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."created_at" := clock_timestamp();
  NEW."severity_rank" := CASE NEW."severity" WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END;
  RETURN NEW;
END
$$;
CREATE TRIGGER "security_alerts_before_insert" BEFORE INSERT ON "security_alerts"
  FOR EACH ROW EXECUTE FUNCTION security_alerts_before_insert();

CREATE FUNCTION security_alerts_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO "security_alert_status" ("alert_id", "status", "updated_at") VALUES (NEW."id", 'open', NEW."created_at");
  RETURN NEW;
END
$$;
CREATE TRIGGER "security_alerts_after_insert" AFTER INSERT ON "security_alerts"
  FOR EACH ROW EXECUTE FUNCTION security_alerts_after_insert();

-- A review step. The database decides the resulting status from the
-- current one, refuses impossible moves, and records the step; the app
-- cannot write the status table at all.
--   open/acknowledged/assigned -> acknowledge -> acknowledged (from open only)
--   any but resolved           -> assign      -> assigned (needs an assignee)
--   any but resolved           -> resolve     -> resolved (needs a resolution and a note)
--   resolved                   -> reopen      -> open     (needs a note)
--   any                        -> comment / escalate: status unchanged
CREATE FUNCTION security_alert_events_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cur "security_alert_status";
BEGIN
  SELECT * INTO cur FROM "security_alert_status" WHERE "alert_id" = NEW."alert_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such alert' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW."at" := clock_timestamp();
  IF NEW."action" = 'acknowledge' THEN
    IF cur."status" <> 'open' THEN RAISE EXCEPTION 'only an open alert can be acknowledged' USING ERRCODE = 'check_violation'; END IF;
    NEW."status_after" := 'acknowledged';
  ELSIF NEW."action" = 'assign' THEN
    IF cur."status" = 'resolved' THEN RAISE EXCEPTION 'reopen a resolved alert before assigning it' USING ERRCODE = 'check_violation'; END IF;
    IF NEW."assignee_id" IS NULL THEN RAISE EXCEPTION 'assign needs an assignee' USING ERRCODE = 'check_violation'; END IF;
    NEW."status_after" := 'assigned';
  ELSIF NEW."action" = 'resolve' THEN
    IF cur."status" = 'resolved' THEN RAISE EXCEPTION 'already resolved' USING ERRCODE = 'check_violation'; END IF;
    IF NEW."resolution" IS NULL OR coalesce(length(btrim(NEW."note")), 0) < 5 THEN
      RAISE EXCEPTION 'resolve needs a resolution and a note' USING ERRCODE = 'check_violation';
    END IF;
    NEW."status_after" := 'resolved';
  ELSIF NEW."action" = 'reopen' THEN
    IF cur."status" <> 'resolved' THEN RAISE EXCEPTION 'only a resolved alert can be reopened' USING ERRCODE = 'check_violation'; END IF;
    IF coalesce(length(btrim(NEW."note")), 0) < 5 THEN RAISE EXCEPTION 'reopen needs a note' USING ERRCODE = 'check_violation'; END IF;
    NEW."status_after" := 'open';
  ELSE
    NEW."status_after" := cur."status";
  END IF;
  IF NEW."action" <> 'assign' THEN
    NEW."assignee_id" := CASE WHEN NEW."action" = 'reopen' THEN NULL ELSE cur."assignee_id" END;
    NEW."assignee_email" := CASE WHEN NEW."action" = 'reopen' THEN NULL ELSE cur."assignee_email" END;
  END IF;
  IF NEW."action" <> 'resolve' THEN NEW."resolution" := NULL; END IF;
  UPDATE "security_alert_status"
     SET "status" = NEW."status_after", "assignee_id" = NEW."assignee_id", "assignee_email" = NEW."assignee_email",
         "resolution" = CASE WHEN NEW."action" = 'resolve' THEN NEW."resolution" WHEN NEW."action" = 'reopen' THEN NULL ELSE "resolution" END,
         "updated_at" = NEW."at"
   WHERE "alert_id" = NEW."alert_id";
  RETURN NEW;
END
$$;
CREATE TRIGGER "security_alert_events_before_insert" BEFORE INSERT ON "security_alert_events"
  FOR EACH ROW EXECUTE FUNCTION security_alert_events_before_insert();

-- Append-only, even for the owner (a superuser can still drop triggers;
-- every alert's cause is also in the hash-chained audit log).
CREATE FUNCTION security_alerts_block_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER "security_alerts_no_update_delete" BEFORE UPDATE OR DELETE ON "security_alerts"
  FOR EACH ROW EXECUTE FUNCTION security_alerts_block_change();
CREATE TRIGGER "security_alerts_no_truncate" BEFORE TRUNCATE ON "security_alerts"
  FOR EACH STATEMENT EXECUTE FUNCTION security_alerts_block_change();
CREATE TRIGGER "security_alert_events_no_update_delete" BEFORE UPDATE OR DELETE ON "security_alert_events"
  FOR EACH ROW EXECUTE FUNCTION security_alerts_block_change();
CREATE TRIGGER "security_alert_events_no_truncate" BEFORE TRUNCATE ON "security_alert_events"
  FOR EACH STATEMENT EXECUTE FUNCTION security_alerts_block_change();
-- The status row is only ever changed by the event trigger above.
CREATE FUNCTION security_alert_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'security_alert_status changes only through security_alert_events' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "security_alert_status_guard" BEFORE UPDATE OR DELETE ON "security_alert_status"
  FOR EACH ROW EXECUTE FUNCTION security_alert_status_guard();
CREATE TRIGGER "security_alert_status_no_truncate" BEFORE TRUNCATE ON "security_alert_status"
  FOR EACH STATEMENT EXECUTE FUNCTION security_alerts_block_change();

-- ------------------------------------------------------- generator state
-- How far through the audit log the alert generator has read. Starts at
-- the current end, so deploying this does not re-alert on old history.
CREATE TABLE "alert_generator_state" (
  "id"          SMALLINT PRIMARY KEY CHECK ("id" = 1),
  "last_seq"    BIGINT NOT NULL,
  "last_run_at" TIMESTAMPTZ(6),
  "last_ok_at"  TIMESTAMPTZ(6),
  "last_error"  TEXT
);
INSERT INTO "alert_generator_state" ("id", "last_seq") SELECT 1, coalesce(max("seq"), 0) FROM "audit_events";
GRANT SELECT, UPDATE ("last_seq", "last_run_at", "last_ok_at", "last_error") ON "alert_generator_state" TO trustvault_app;

-- The watermark only moves forward.
CREATE FUNCTION alert_generator_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."last_seq" < OLD."last_seq" THEN
    RAISE EXCEPTION 'the alert watermark cannot move backwards' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "alert_generator_state_guard" BEFORE UPDATE ON "alert_generator_state"
  FOR EACH ROW EXECUTE FUNCTION alert_generator_state_guard();

-- ------------------------------------------------- accessible documents
-- How many live documents a person can currently download, by the same
-- rule as tv_doc_level() (READ = 2 or better; View only never downloads).
-- For the "fraction of accessible documents taken" rule; returns a number,
-- never which documents.
CREATE FUNCTION tv_accessible_document_count(p_user uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT count(*) FROM documents d WHERE d.status = 'ACTIVE' AND tv_doc_level(d.id, p_user) >= 2
$$;
REVOKE ALL ON FUNCTION tv_accessible_document_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_accessible_document_count(uuid) TO trustvault_app;

-- ------------------------------------------------- administrators only
-- Thresholds and limit exceptions are changed only in an active
-- administrator's transaction (the API also checks the role and a fresh
-- second factor): the same backstop as app_settings and groups.
CREATE TRIGGER "risk_settings_admin_only" BEFORE INSERT OR UPDATE OR DELETE ON "risk_settings"
  FOR EACH ROW EXECUTE FUNCTION tv_admin_only_write();
CREATE TRIGGER "download_limit_overrides_admin_only" BEFORE INSERT OR UPDATE OR DELETE ON "download_limit_overrides"
  FOR EACH ROW EXECUTE FUNCTION tv_admin_only_write();
