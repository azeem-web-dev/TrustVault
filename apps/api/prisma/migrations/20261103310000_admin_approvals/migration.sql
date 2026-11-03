-- Two administrators for the actions that can open someone else's account or
-- documents (THREATS.md S15, S19): clearing an OWNER's or ADMIN's second
-- factor, and break-glass. One admin asks, with a reason; a different active
-- admin approves or rejects; the one who asked then uses the approval, once,
-- for exactly the person or document named, within 24 hours.
--
-- Every rule is checked here as well as in the API, so the app's database
-- role cannot skip it with direct SQL: nobody approves their own request,
-- only an active ADMIN approves, an approval is bound to its action and
-- target, and it is used at most once.

CREATE TYPE "ApprovalAction" AS ENUM ('MFA_RESET', 'BREAK_GLASS');

CREATE TABLE "admin_approvals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "action" "ApprovalAction" NOT NULL,
  "target_user_id" UUID REFERENCES "users"("id") ON DELETE CASCADE,
  "target_document_id" UUID REFERENCES "documents"("id") ON DELETE CASCADE,
  "reason" TEXT NOT NULL,
  "requested_by" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "approved_by" UUID REFERENCES "users"("id") ON DELETE CASCADE,
  "approved_at" TIMESTAMPTZ(6),
  "rejected_by" UUID REFERENCES "users"("id") ON DELETE CASCADE,
  "rejected_at" TIMESTAMPTZ(6),
  "consumed_at" TIMESTAMPTZ(6),
  "expiry_recorded_at" TIMESTAMPTZ(6),
  CONSTRAINT "admin_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "approvals_reason_len" CHECK (char_length("reason") BETWEEN 20 AND 500),
  CONSTRAINT "approvals_target_shape" CHECK (
    ("action" = 'MFA_RESET' AND "target_user_id" IS NOT NULL AND "target_document_id" IS NULL)
    OR ("action" = 'BREAK_GLASS' AND "target_document_id" IS NOT NULL AND "target_user_id" IS NULL)),
  -- Nobody approves or rejects their own request.
  CONSTRAINT "approvals_two_people" CHECK ("approved_by" IS DISTINCT FROM "requested_by" AND "rejected_by" IS DISTINCT FROM "requested_by"),
  CONSTRAINT "approvals_approved_pair" CHECK (("approved_by" IS NULL) = ("approved_at" IS NULL)),
  CONSTRAINT "approvals_rejected_pair" CHECK (("rejected_by" IS NULL) = ("rejected_at" IS NULL)),
  CONSTRAINT "approvals_one_answer" CHECK ("approved_at" IS NULL OR "rejected_at" IS NULL),
  CONSTRAINT "approvals_used_after_approval" CHECK ("consumed_at" IS NULL OR "approved_at" IS NOT NULL),
  CONSTRAINT "approvals_one_day" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '24 hours')
);
CREATE INDEX "admin_approvals_created_at_idx" ON "admin_approvals"("created_at");
CREATE INDEX "admin_approvals_target_user_idx" ON "admin_approvals"("target_user_id");

-- Is this an active administrator? (Reads users regardless of any policy.)
CREATE FUNCTION tv_is_active_admin(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT role = 'ADMIN' AND status = 'ACTIVE' AND (access_expires_at IS NULL OR access_expires_at > clock_timestamp())
                     FROM users WHERE id = p_user), false)
$$;
REVOKE ALL ON FUNCTION tv_is_active_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_is_active_admin(uuid) TO trustvault_app;

-- A request: always by the admin in this transaction, starting now, open 24 hours.
CREATE FUNCTION admin_approvals_guard_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.requested_by IS DISTINCT FROM tv_current_user() OR NOT tv_is_active_admin(NEW.requested_by) THEN
    RAISE EXCEPTION 'approval requests are made by an active administrator, as themselves' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.approved_by IS NOT NULL OR NEW.rejected_by IS NOT NULL OR NEW.consumed_at IS NOT NULL OR NEW.expiry_recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'a new request starts unanswered' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.action = 'MFA_RESET' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.target_user_id AND u.role IN ('OWNER', 'ADMIN')) THEN
    RAISE EXCEPTION 'two-admin approval is for owners'' and administrators'' second factors' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.target_user_id = NEW.requested_by THEN
    RAISE EXCEPTION 'another admin must ask to reset your second factor' USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  NEW.expires_at := now() + interval '24 hours';
  RETURN NEW;
END
$$;
CREATE TRIGGER admin_approvals_guard_insert BEFORE INSERT ON "admin_approvals"
  FOR EACH ROW EXECUTE FUNCTION admin_approvals_guard_insert();

-- Exactly one step per update, each by the right person:
--   approve or reject: an active admin who is not the requester, while open;
--   use: the requester, still an active admin, once, after approval, in time;
--   note the expiry: anyone, once it has passed (so the log can say so).
CREATE FUNCTION admin_approvals_guard_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  me uuid := tv_current_user();
  open_ boolean := OLD.approved_at IS NULL AND OLD.rejected_at IS NULL;
BEGIN
  IF (NEW.id, NEW.action, NEW.target_user_id, NEW.target_document_id, NEW.reason, NEW.requested_by, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.action, OLD.target_user_id, OLD.target_document_id, OLD.reason, OLD.requested_by, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'an approval request cannot be rewritten' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    IF NOT open_ OR OLD.expires_at <= now() OR NEW.approved_by IS DISTINCT FROM me OR me = OLD.requested_by OR NOT tv_is_active_admin(me)
       OR NEW.rejected_by IS DISTINCT FROM OLD.rejected_by OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
      RAISE EXCEPTION 'approval refused: another active administrator approves an open request, as themselves' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.approved_at := now();
  ELSIF NEW.rejected_by IS DISTINCT FROM OLD.rejected_by OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at THEN
    IF NOT open_ OR OLD.expires_at <= now() OR NEW.rejected_by IS DISTINCT FROM me OR me = OLD.requested_by OR NOT tv_is_active_admin(me)
       OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
      RAISE EXCEPTION 'rejection refused: another active administrator rejects an open request, as themselves' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.rejected_at := now();
  ELSIF NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    IF OLD.consumed_at IS NOT NULL OR OLD.approved_at IS NULL OR OLD.rejected_at IS NOT NULL OR OLD.expires_at <= now()
       OR me IS DISTINCT FROM OLD.requested_by OR NOT tv_is_active_admin(me) THEN
      RAISE EXCEPTION 'this approval cannot be used: it must be approved, unused, unexpired, and used by the admin who asked' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.consumed_at := now();
  ELSIF NEW.expiry_recorded_at IS DISTINCT FROM OLD.expiry_recorded_at THEN
    IF OLD.expiry_recorded_at IS NOT NULL OR OLD.expires_at > now() OR OLD.consumed_at IS NOT NULL OR OLD.rejected_at IS NOT NULL THEN
      RAISE EXCEPTION 'only an unused request past its expiry can be marked expired' USING ERRCODE = 'check_violation';
    END IF;
    NEW.expiry_recorded_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER admin_approvals_guard_update BEFORE UPDATE ON "admin_approvals"
  FOR EACH ROW EXECUTE FUNCTION admin_approvals_guard_update();

CREATE TRIGGER admin_approvals_no_delete BEFORE DELETE ON "admin_approvals"
  FOR EACH ROW EXECUTE FUNCTION audit_block_change();
REVOKE ALL ON FUNCTION admin_approvals_guard_insert(), admin_approvals_guard_update() FROM PUBLIC;

-- Administrators only, and only in a transaction that says who is asking.
GRANT SELECT, INSERT, UPDATE ON "admin_approvals" TO trustvault_app;
ALTER TABLE "admin_approvals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY approvals_admins ON "admin_approvals" FOR ALL TO trustvault_app
  USING (tv_is_active_admin(tv_current_user())) WITH CHECK (tv_is_active_admin(tv_current_user()));

-- ---------- Break-glass needs an approval, used in the same transaction ----------
ALTER TABLE "break_glass" ADD COLUMN "approval_id" UUID REFERENCES "admin_approvals"("id");
CREATE UNIQUE INDEX "break_glass_approval_id_key" ON "break_glass"("approval_id");

-- Not SECURITY DEFINER: it reads admin_approvals as the caller, so row-level
-- security applies too. The schema owner (migrations, test setup) is exempt,
-- as in documents_guard_update.
CREATE FUNCTION break_glass_needs_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- The approval named must be for break-glass on this document, asked for by
  -- this admin, and used in this very transaction (consumed_at = now()).
  IF NOT pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'break_glass'), 'MEMBER')
     AND NOT EXISTS (SELECT 1 FROM admin_approvals a
                  WHERE a.id = NEW.approval_id AND a.action = 'BREAK_GLASS' AND a.target_document_id = NEW.document_id
                    AND a.requested_by = NEW.admin_id AND a.consumed_at = now()) THEN
    RAISE EXCEPTION 'break-glass needs a second administrator''s approval for this document, used now' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION break_glass_needs_approval() FROM PUBLIC;
CREATE TRIGGER break_glass_needs_approval BEFORE INSERT ON "break_glass"
  FOR EACH ROW EXECUTE FUNCTION break_glass_needs_approval();
