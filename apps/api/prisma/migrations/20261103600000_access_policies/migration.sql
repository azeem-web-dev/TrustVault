-- Access policies on shares (THREATS.md P1-P12, checklist items 16 and 18).
--
-- A share (grant) can now carry conditions, chosen by the document owner:
--
--   * a time window: days of the week and hours, in a named IANA time zone;
--   * a network allowlist: CIDR ranges the request must come from;
--   * "downloads need approval": the recipient may open the document's
--     details, but its bytes are released only against an approval that the
--     owner (or a manager the owner nominated) gave to that person, for that
--     exact version, single-use or for a few uses within a short window.
--
-- Administrators can set the same window and network rules per role
-- (organisation-wide). Those apply on top of every share to people with that
-- role; an owner cannot lift them.
--
-- The owner can give one person an emergency exception on one document: a
-- time-boxed override of the share's own conditions (never of the role
-- rules), with a written reason, audited and notified.
--
-- The database lock enforces all of it independently of the API:
--   * tv_doc_level() counts a grant only while tv_grant_usable() says so, so
--     outside its window or network a grant gives nothing, in every policy
--     that uses tv_doc_level();
--   * a RESTRICTIVE policy on document_blobs refuses the encrypted bytes
--     unless tv_blob_release_ok() — no approval needed, or an approval for
--     this person and version consumed in THIS transaction;
--   * decisions on requests go through SECURITY DEFINER functions, the app
--     role cannot UPDATE or DELETE requests, and a CHECK constraint makes
--     "approved by the person who asked" impossible for any writer.
--
-- The client IP reaches the database as app.client_ip, set by the API next to
-- app.user_id (transaction-local). The API derives it from the socket and
-- trusts X-Forwarded-For only from the configured proxy. The database cannot
-- verify it: a compromised API process can lie about the IP. The network rule
-- is therefore a guard against application bugs and stolen credentials used
-- from elsewhere, not against a compromised server (THREATS.md P7).

-- ---------- Validation helpers ----------
CREATE FUNCTION tv_tz_valid(p_tz text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  -- Only named zones, never POSIX strings like 'UTC+5' (whose sign Postgres
  -- reads the other way round from what people expect).
  SELECT p_tz ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
     AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz)
$$;

CREATE FUNCTION tv_cidrs_valid(p_cidrs text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  -- The cast raises on anything malformed (including host bits set).
  SELECT p_cidrs IS NULL
      OR (cardinality(p_cidrs) BETWEEN 1 AND 32
          AND (SELECT bool_and(c IS NOT NULL AND c::cidr IS NOT NULL) FROM unnest(p_cidrs) AS c))
$$;

-- Is local time at p_at inside the window? Days are ISO (1 Monday .. 7
-- Sunday) of the LOCAL date; minutes are local minutes since midnight,
-- start inclusive, end exclusive (1440 = end of the day). AT TIME ZONE uses
-- the zone's rules for that instant, so daylight-saving changes need no
-- special case: on a spring-forward day the skipped hour simply never
-- occurs, on a fall-back day the repeated hour occurs twice.
CREATE FUNCTION tv_in_window(p_days smallint[], p_start smallint, p_end smallint, p_tz text, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p_days IS NULL THEN true
    ELSE (SELECT extract(isodow FROM l)::smallint = ANY (p_days)
                 AND (extract(hour FROM l) * 60 + extract(minute FROM l)) >= p_start
                 AND (extract(hour FROM l) * 60 + extract(minute FROM l)) < p_end
            FROM (SELECT p_at AT TIME ZONE p_tz AS l) AS x)
  END
$$;

-- The client address the API put on this transaction. Unset or malformed
-- means unknown, and an unknown address matches no allowlist.
CREATE FUNCTION tv_client_ip() RETURNS inet
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  RETURN nullif(current_setting('app.client_ip', true), '')::inet;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

CREATE FUNCTION tv_ip_allowed(p_cidrs text[], p_ip inet) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT p_cidrs IS NULL
      OR (p_ip IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(p_cidrs) AS c WHERE p_ip <<= c::cidr))
$$;

-- ---------- Conditions on a share ----------
ALTER TABLE "grants"
  ADD COLUMN "download_approval" boolean NOT NULL DEFAULT false,
  ADD COLUMN "download_approver_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN "window_days" smallint[],
  ADD COLUMN "window_start_min" smallint,
  ADD COLUMN "window_end_min" smallint,
  ADD COLUMN "window_tz" text,
  ADD COLUMN "allowed_cidrs" text[];
ALTER TABLE "grants" ADD CONSTRAINT "grants_window_shape" CHECK (
  ("window_days" IS NULL AND "window_start_min" IS NULL AND "window_end_min" IS NULL AND "window_tz" IS NULL)
  OR ("window_days" IS NOT NULL AND cardinality("window_days") BETWEEN 1 AND 7
      AND array_position("window_days", NULL) IS NULL
      AND "window_days" <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
      AND "window_start_min" BETWEEN 0 AND 1439 AND "window_end_min" BETWEEN 1 AND 1440
      AND "window_start_min" < "window_end_min" AND "window_tz" IS NOT NULL));
ALTER TABLE "grants" ADD CONSTRAINT "grants_cidrs_valid" CHECK (tv_cidrs_valid("allowed_cidrs"));
ALTER TABLE "grants" ADD CONSTRAINT "grants_approver_needs_approval" CHECK ("download_approver_id" IS NULL OR "download_approval");
ALTER TABLE "grants" ADD CONSTRAINT "grants_approver_not_grantee" CHECK ("download_approver_id" IS NULL OR "user_id" IS NULL OR "download_approver_id" <> "user_id");

-- ---------- Organisation-wide rules per role (set by administrators) ----------
CREATE TABLE "role_access_policies" (
  "role" "Role" PRIMARY KEY,
  "window_days" smallint[],
  "window_start_min" smallint,
  "window_end_min" smallint,
  "window_tz" text,
  "allowed_cidrs" text[],
  "updated_by_id" uuid NOT NULL REFERENCES "users"("id"),
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Administrators never reach documents through shares; nothing to restrict.
  CONSTRAINT "role_policy_not_admin" CHECK ("role" <> 'ADMIN'),
  CONSTRAINT "role_policy_says_something" CHECK ("window_days" IS NOT NULL OR "allowed_cidrs" IS NOT NULL),
  CONSTRAINT "role_policy_window_shape" CHECK (
    ("window_days" IS NULL AND "window_start_min" IS NULL AND "window_end_min" IS NULL AND "window_tz" IS NULL)
    OR ("window_days" IS NOT NULL AND cardinality("window_days") BETWEEN 1 AND 7
        AND array_position("window_days", NULL) IS NULL
        AND "window_days" <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
        AND "window_start_min" BETWEEN 0 AND 1439 AND "window_end_min" BETWEEN 1 AND 1440
        AND "window_start_min" < "window_end_min" AND "window_tz" IS NOT NULL)),
  CONSTRAINT "role_policy_cidrs_valid" CHECK (tv_cidrs_valid("allowed_cidrs"))
);

-- ---------- Emergency exceptions ----------
CREATE TABLE "access_overrides" (
  "id" uuid PRIMARY KEY,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_by_id" uuid NOT NULL REFERENCES "users"("id"),
  "reason" text NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" timestamptz(6) NOT NULL,
  "revoked_at" timestamptz(6),
  "revoked_by_id" uuid REFERENCES "users"("id"),
  CONSTRAINT "override_reason_len" CHECK (char_length("reason") BETWEEN 10 AND 500),
  CONSTRAINT "override_not_self" CHECK ("user_id" <> "created_by_id"),
  CONSTRAINT "override_window" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '24 hours 1 minute')
);
CREATE INDEX "access_overrides_doc_user_idx" ON "access_overrides"("document_id", "user_id");

-- ---------- Download requests and approvals ----------
CREATE TYPE "DownloadApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'USED', 'REJECTED', 'EXPIRED', 'CANCELLED');
CREATE TABLE "download_approvals" (
  "id" uuid PRIMARY KEY,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "version_id" uuid NOT NULL REFERENCES "document_versions"("id") ON DELETE CASCADE,
  "requester_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "reason" text NOT NULL,
  "status" "DownloadApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "decided_by_id" uuid REFERENCES "users"("id"),
  "decided_at" timestamptz(6),
  "decision_note" text,
  "valid_until" timestamptz(6),
  "max_uses" int,
  "uses" int NOT NULL DEFAULT 0,
  -- The transaction that last consumed a use; the blob policy accepts the
  -- approval only inside that same transaction.
  "last_use_tx" bigint,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "download_approvals_reason_len" CHECK (char_length("reason") BETWEEN 10 AND 500),
  CONSTRAINT "download_approvals_note_len" CHECK ("decision_note" IS NULL OR char_length("decision_note") <= 500),
  -- Nobody approves (or rejects) their own request. Holds for every writer,
  -- including SECURITY DEFINER functions and the schema owner.
  CONSTRAINT "download_approvals_not_self" CHECK ("decided_by_id" IS NULL OR "decided_by_id" <> "requester_id"),
  CONSTRAINT "download_approvals_decided" CHECK (("status" IN ('PENDING', 'EXPIRED', 'CANCELLED')) OR ("decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL)),
  CONSTRAINT "download_approvals_terms" CHECK ("status" NOT IN ('APPROVED', 'USED') OR ("valid_until" IS NOT NULL AND "max_uses" IS NOT NULL)),
  CONSTRAINT "download_approvals_uses" CHECK ("uses" >= 0 AND "uses" <= coalesce("max_uses", 0) AND ("max_uses" IS NULL OR "max_uses" BETWEEN 1 AND 10)),
  CONSTRAINT "download_approvals_window" CHECK ("valid_until" IS NULL OR ("decided_at" IS NOT NULL AND "valid_until" <= "decided_at" + interval '72 hours 1 minute'))
);
CREATE INDEX "download_approvals_doc_idx" ON "download_approvals"("document_id", "created_at");
CREATE INDEX "download_approvals_requester_idx" ON "download_approvals"("requester_id", "version_id");
-- One open request per person and version.
CREATE UNIQUE INDEX "download_approvals_one_pending" ON "download_approvals"("requester_id", "version_id") WHERE "status" = 'PENDING';

-- ---------- When does a grant count? ----------
-- A live grant counts only while the role rules and its own conditions allow
-- it at p_at from the client IP of this transaction. An owner's emergency
-- exception lifts the share's own conditions, never the role rules.
CREATE FUNCTION tv_grant_usable(p_grant uuid, p_user uuid, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((
    SELECT NOT EXISTS (
             SELECT 1 FROM users u JOIN role_access_policies r ON r.role = u.role
              WHERE u.id = p_user
                AND NOT (tv_in_window(r.window_days, r.window_start_min, r.window_end_min, r.window_tz, p_at)
                         AND tv_ip_allowed(r.allowed_cidrs, tv_client_ip())))
       AND ((tv_in_window(g.window_days, g.window_start_min, g.window_end_min, g.window_tz, p_at)
             AND tv_ip_allowed(g.allowed_cidrs, tv_client_ip()))
            OR EXISTS (SELECT 1 FROM access_overrides o
                        WHERE o.document_id = g.document_id AND o.user_id = p_user
                          AND o.revoked_at IS NULL AND o.expires_at > p_at))
      FROM grants g WHERE g.id = p_grant), false)
$$;
REVOKE ALL ON FUNCTION tv_grant_usable(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_grant_usable(uuid, uuid, timestamptz) TO trustvault_app;
GRANT EXECUTE ON FUNCTION tv_in_window(smallint[], smallint, smallint, text, timestamptz), tv_client_ip(), tv_ip_allowed(text[], inet),
  tv_tz_valid(text), tv_cidrs_valid(text[]) TO trustvault_app;

-- The database lock: as in 20261103200100_view_only (levels 0 none, 1 VIEW,
-- 2 READ, 3 EDIT, 4 MANAGE, 5 owner), plus one condition on grants
-- ("AND tv_grant_usable(...)"). Owners and break-glass are unaffected.
CREATE OR REPLACE FUNCTION tv_doc_level(p_doc uuid, p_user uuid) RETURNS int
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  u_role "Role";
  d_owner uuid;
  d_status "DocumentStatus";
  lvl int := 0;
  t timestamptz := clock_timestamp();
BEGIN
  IF p_doc IS NULL OR p_user IS NULL THEN RETURN 0; END IF;

  SELECT role INTO u_role FROM users
   WHERE id = p_user AND status = 'ACTIVE' AND (access_expires_at IS NULL OR access_expires_at > t);
  IF NOT FOUND THEN RETURN 0; END IF;            -- deactivated, expired or unknown

  SELECT owner_id, status INTO d_owner, d_status FROM documents WHERE id = p_doc;
  IF NOT FOUND THEN RETURN 0; END IF;

  -- Administrators: no ownership, no grants, no groups. Break-glass gives
  -- VIEW only: an emergency look, never the original file (THREATS.md A9, V9).
  IF u_role = 'ADMIN' THEN
    IF d_status = 'ACTIVE' AND EXISTS (
         SELECT 1 FROM break_glass b WHERE b.document_id = p_doc AND b.admin_id = p_user AND b.expires_at > t) THEN
      RETURN 1;
    END IF;
    RETURN 0;
  END IF;

  IF d_owner = p_user THEN RETURN 5; END IF;     -- owners keep access to their own trash
  IF d_status <> 'ACTIVE' THEN RETURN 0; END IF; -- nobody else sees deleted documents

  SELECT coalesce(max(CASE g.level WHEN 'MANAGE' THEN 4 WHEN 'EDIT' THEN 3 WHEN 'READ' THEN 2 ELSE 1 END), 0) INTO lvl
    FROM grants g
   WHERE g.document_id = p_doc
     AND (g.expires_at IS NULL OR g.expires_at > t)
     AND (g.user_id = p_user
          OR (u_role <> 'EXTERNAL'
              AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.group_id AND gm.user_id = p_user)
              AND EXISTS (SELECT 1 FROM grant_group_members c WHERE c.grant_id = g.id AND c.user_id = p_user)))
     AND tv_grant_usable(g.id, p_user, t);        -- time window, network, role rules (access policies)

  IF u_role = 'EXTERNAL' THEN lvl := least(lvl, 2); END IF;  -- externals: READ at most
  RETURN lvl;
END
$$;

-- Does this person need an approval to get the bytes? Yes, unless a live,
-- usable grant that gives the right to download (READ, EDIT or MANAGE —
-- named, so a lower "view only" level added later never counts) does NOT
-- ask for approval, or the owner gave an emergency exception.
CREATE FUNCTION tv_download_needs_approval(p_doc uuid, p_user uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  t timestamptz := clock_timestamp();
  u_role "Role";
BEGIN
  SELECT role INTO u_role FROM users WHERE id = p_user;
  IF NOT FOUND THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM access_overrides o WHERE o.document_id = p_doc AND o.user_id = p_user
               AND o.revoked_at IS NULL AND o.expires_at > t) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM grants g
     WHERE g.document_id = p_doc
       AND g.level IN ('READ', 'EDIT', 'MANAGE')
       AND NOT g.download_approval
       AND (g.expires_at IS NULL OR g.expires_at > t)
       AND (g.user_id = p_user
            OR (u_role <> 'EXTERNAL'
                AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.group_id AND gm.user_id = p_user)
                AND EXISTS (SELECT 1 FROM grant_group_members c WHERE c.grant_id = g.id AND c.user_id = p_user)))
       AND tv_grant_usable(g.id, p_user, t));
END
$$;
REVOKE ALL ON FUNCTION tv_download_needs_approval(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_download_needs_approval(uuid, uuid) TO trustvault_app;

-- May the current user receive this version's encrypted bytes? Used by the
-- RESTRICTIVE blob policy below, so it narrows blobs_select whatever that
-- policy says. Owners, the person who uploaded the version, and break-glass
-- (an admin rule with its own one-hour limit and alert) are not asked.
CREATE FUNCTION tv_blob_release_ok(p_version uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  me uuid := tv_current_user();
  v_doc uuid;
  v_uploader uuid;
  d_owner uuid;
  u_role "Role";
BEGIN
  IF me IS NULL THEN RETURN false; END IF;
  SELECT v.document_id, v.uploaded_by_id, d.owner_id INTO v_doc, v_uploader, d_owner
    FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = p_version;
  IF NOT FOUND THEN RETURN false; END IF;
  IF d_owner = me OR v_uploader = me THEN RETURN true; END IF;
  SELECT role INTO u_role FROM users WHERE id = me;
  IF u_role = 'ADMIN' THEN RETURN true; END IF;
  IF NOT tv_download_needs_approval(v_doc, me) THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM download_approvals a
     WHERE a.version_id = p_version AND a.requester_id = me
       AND a.status IN ('APPROVED', 'USED') AND a.valid_until > clock_timestamp()
       AND a.last_use_tx IS NOT NULL AND a.last_use_tx = txid_current_if_assigned());
END
$$;
REVOKE ALL ON FUNCTION tv_blob_release_ok(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_blob_release_ok(uuid) TO trustvault_app;

CREATE POLICY blobs_release ON "document_blobs" AS RESTRICTIVE FOR SELECT TO trustvault_app
  USING (tv_blob_release_ok(version_id));

-- Owner of a document, read without row-level security (for policies on the
-- tables below; avoids policy recursion through documents).
CREATE FUNCTION tv_doc_owner(p_doc uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.owner_id FROM documents d JOIN users u ON u.id = d.owner_id
   WHERE d.id = p_doc AND u.status = 'ACTIVE' AND u.role = 'OWNER'
$$;
REVOKE ALL ON FUNCTION tv_doc_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_doc_owner(uuid) TO trustvault_app;

-- May p_user decide this request? The document's owner, or a manager whom
-- the owner nominated on a share that covers the requester and asks for
-- approval — and in every case not the requester.
CREATE FUNCTION tv_may_decide_download(p_request uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((
    SELECT a.requester_id <> p_user AND (
             tv_doc_owner(a.document_id) = p_user
          OR (tv_doc_level(a.document_id, p_user) >= 4   -- MANAGE (levels as in 20261103200100_view_only)
              AND EXISTS (SELECT 1 FROM grants g
                           WHERE g.document_id = a.document_id AND g.download_approval AND g.download_approver_id = p_user
                             AND (g.user_id = a.requester_id
                                  OR EXISTS (SELECT 1 FROM grant_group_members c WHERE c.grant_id = g.id AND c.user_id = a.requester_id)))))
      FROM download_approvals a WHERE a.id = p_request), false)
$$;
REVOKE ALL ON FUNCTION tv_may_decide_download(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_may_decide_download(uuid, uuid) TO trustvault_app;

-- ---------- Privileges and row-level security ----------
GRANT SELECT ON "role_access_policies" TO trustvault_app;
GRANT INSERT, UPDATE, DELETE ON "role_access_policies" TO trustvault_app;
GRANT SELECT, INSERT ON "access_overrides" TO trustvault_app;      -- ended only through tv_end_override()
GRANT SELECT, INSERT ON "download_approvals" TO trustvault_app;    -- decided only through the functions below

ALTER TABLE "role_access_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "download_approvals" ENABLE ROW LEVEL SECURITY;

-- Everyone may read the role rules (the web shows people why they are refused).
CREATE POLICY role_policies_select ON "role_access_policies" FOR SELECT TO trustvault_app USING (true);
-- Only an active administrator changes them, and only in their own name.
CREATE POLICY role_policies_write ON "role_access_policies" FOR ALL TO trustvault_app
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = tv_current_user() AND u.role = 'ADMIN' AND u.status = 'ACTIVE'))
  WITH CHECK (updated_by_id = tv_current_user()
              AND EXISTS (SELECT 1 FROM users u WHERE u.id = tv_current_user() AND u.role = 'ADMIN' AND u.status = 'ACTIVE'));

CREATE POLICY overrides_select ON "access_overrides" FOR SELECT TO trustvault_app
  USING (user_id = tv_current_user() OR tv_doc_owner(document_id) = tv_current_user());
CREATE POLICY overrides_insert ON "access_overrides" FOR INSERT TO trustvault_app
  WITH CHECK (created_by_id = tv_current_user() AND tv_doc_owner(document_id) = tv_current_user());

CREATE POLICY approvals_select ON "download_approvals" FOR SELECT TO trustvault_app
  USING (requester_id = tv_current_user() OR tv_may_decide_download(id, tv_current_user()));
CREATE POLICY approvals_insert ON "download_approvals" FOR INSERT TO trustvault_app
  WITH CHECK (requester_id = tv_current_user() AND tv_doc_level(document_id, tv_current_user()) >= 2);  -- READ: VIEW never downloads

-- ---------- Rules the policies cannot express ----------
CREATE FUNCTION access_policy_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.window_tz IS NOT NULL AND NOT tv_tz_valid(NEW.window_tz) THEN
    RAISE EXCEPTION 'unknown time zone' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'role_access_policies' THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  -- grants: a nominated approver must be able to manage the document now.
  IF NEW.download_approver_id IS NOT NULL AND tv_doc_level(NEW.document_id, NEW.download_approver_id) < 4 THEN
    RAISE EXCEPTION 'the nominated approver must be able to manage this document' USING ERRCODE = 'check_violation';
  END IF;
  -- Only the owner may change conditions a share already has (a manager could
  -- otherwise lift what the owner set). A share with no conditions may be
  -- given some by whoever may share: that only narrows access.
  IF TG_OP = 'UPDATE'
     AND (OLD.download_approval OR OLD.window_days IS NOT NULL OR OLD.allowed_cidrs IS NOT NULL)
     AND (NEW.download_approval, NEW.download_approver_id, NEW.window_days, NEW.window_start_min, NEW.window_end_min, NEW.window_tz, NEW.allowed_cidrs)
         IS DISTINCT FROM
         (OLD.download_approval, OLD.download_approver_id, OLD.window_days, OLD.window_start_min, OLD.window_end_min, OLD.window_tz, OLD.allowed_cidrs)
     AND tv_doc_owner(NEW.document_id) IS DISTINCT FROM NEW.granted_by_id
     -- session_user: inside this SECURITY DEFINER function current_user is the owner.
     AND NOT pg_has_role(session_user, (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'grants'), 'MEMBER') THEN
    RAISE EXCEPTION 'only the owner can change the conditions on a share' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER grants_access_policy_guard BEFORE INSERT OR UPDATE ON "grants"
  FOR EACH ROW EXECUTE FUNCTION access_policy_guard();
CREATE TRIGGER role_access_policy_guard BEFORE INSERT OR UPDATE ON "role_access_policies"
  FOR EACH ROW EXECUTE FUNCTION access_policy_guard();

-- Overrides start now and last at most 24 hours; only the owner, for someone
-- who holds a share on the document.
CREATE FUNCTION access_overrides_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.created_at := now();
  NEW.revoked_at := NULL;
  NEW.revoked_by_id := NULL;
  IF NEW.expires_at <= now() OR NEW.expires_at > now() + interval '24 hours' THEN
    RAISE EXCEPTION 'an exception lasts between now and 24 hours' USING ERRCODE = 'check_violation';
  END IF;
  IF tv_doc_owner(NEW.document_id) IS DISTINCT FROM NEW.created_by_id THEN
    RAISE EXCEPTION 'only the owner can give an exception' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM grants g WHERE g.document_id = NEW.document_id
                   AND (g.user_id = NEW.user_id
                        OR EXISTS (SELECT 1 FROM grant_group_members c WHERE c.grant_id = g.id AND c.user_id = NEW.user_id))) THEN
    RAISE EXCEPTION 'an exception needs a share to apply to' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER access_overrides_guard BEFORE INSERT ON "access_overrides"
  FOR EACH ROW EXECUTE FUNCTION access_overrides_guard();

-- A new request is always PENDING, undecided, unused, created now, for a
-- version of the document it names.
CREATE FUNCTION download_approvals_guard_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.status := 'PENDING';
  NEW.decided_by_id := NULL;
  NEW.decided_at := NULL;
  NEW.decision_note := NULL;
  NEW.valid_until := NULL;
  NEW.max_uses := NULL;
  NEW.uses := 0;
  NEW.last_use_tx := NULL;
  NEW.created_at := now();
  IF NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.id = NEW.version_id AND v.document_id = NEW.document_id) THEN
    RAISE EXCEPTION 'that version is not part of this document' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER download_approvals_guard_insert BEFORE INSERT ON "download_approvals"
  FOR EACH ROW EXECUTE FUNCTION download_approvals_guard_insert();

-- ---------- The only ways a request changes ----------
-- Approve or reject, as the current user. Returns the row as decided. A
-- request still pending after 7 days is expired instead of decided.
CREATE FUNCTION tv_decide_download(p_request uuid, p_approve boolean, p_note text, p_hours int, p_uses int)
RETURNS SETOF download_approvals
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  me uuid := tv_current_user();
  a download_approvals%ROWTYPE;
BEGIN
  SELECT * INTO a FROM download_approvals WHERE id = p_request FOR UPDATE;
  IF NOT FOUND OR me IS NULL THEN
    RAISE EXCEPTION 'no such request' USING ERRCODE = 'no_data_found';
  END IF;
  IF a.requester_id = me THEN
    RAISE EXCEPTION 'nobody can decide their own download request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT tv_may_decide_download(p_request, me) THEN
    RAISE EXCEPTION 'only the owner or the nominated approver can decide this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF a.status <> 'PENDING' THEN
    RAISE EXCEPTION 'this request was already %', lower(a.status::text) USING ERRCODE = 'check_violation';
  END IF;
  IF a.created_at < now() - interval '7 days' THEN
    UPDATE download_approvals SET status = 'EXPIRED' WHERE id = p_request RETURNING * INTO a;
    RETURN NEXT a;
    RETURN;
  END IF;
  IF p_approve THEN
    IF p_hours IS NULL OR p_hours NOT BETWEEN 1 AND 72 OR p_uses IS NULL OR p_uses NOT BETWEEN 1 AND 10 THEN
      RAISE EXCEPTION 'an approval lasts 1 to 72 hours and allows 1 to 10 downloads' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE download_approvals
       SET status = 'APPROVED', decided_by_id = me, decided_at = now(), decision_note = p_note,
           valid_until = now() + make_interval(hours => p_hours), max_uses = p_uses
     WHERE id = p_request RETURNING * INTO a;
  ELSE
    UPDATE download_approvals
       SET status = 'REJECTED', decided_by_id = me, decided_at = now(), decision_note = p_note
     WHERE id = p_request RETURNING * INTO a;
  END IF;
  RETURN NEXT a;
END
$$;
REVOKE ALL ON FUNCTION tv_decide_download(uuid, boolean, text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_decide_download(uuid, boolean, text, int, int) TO trustvault_app;

-- Use one download of an approval, as the current user, for that exact
-- version, while the approval is live and the person still has access.
-- Returns the number of uses after this one, or NULL if refused. The blob
-- policy then releases the bytes inside this transaction only.
CREATE FUNCTION tv_consume_download(p_request uuid, p_version uuid) RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  me uuid := tv_current_user();
  a download_approvals%ROWTYPE;
BEGIN
  SELECT * INTO a FROM download_approvals
   WHERE id = p_request AND requester_id = me AND version_id = p_version FOR UPDATE;
  IF NOT FOUND OR a.status <> 'APPROVED' OR a.valid_until <= clock_timestamp() OR a.uses >= a.max_uses
     OR tv_doc_level(a.document_id, me) < 2 THEN  -- READ, live
    RETURN NULL;
  END IF;
  UPDATE download_approvals
     SET uses = uses + 1,
         status = CASE WHEN uses + 1 >= max_uses THEN 'USED'::"DownloadApprovalStatus" ELSE status END,
         last_use_tx = txid_current()
   WHERE id = p_request;
  RETURN a.uses + 1;
END
$$;
REVOKE ALL ON FUNCTION tv_consume_download(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_consume_download(uuid, uuid) TO trustvault_app;

-- Expire what has run out: requests pending for 7 days, approvals past their
-- window with uses left. Returns what changed, for the audit log.
CREATE FUNCTION tv_expire_downloads()
RETURNS TABLE (id uuid, document_id uuid, requester_id uuid, was "DownloadApprovalStatus")
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH old AS (
    SELECT a.id, a.status FROM download_approvals a
     WHERE (a.status = 'PENDING' AND a.created_at < now() - interval '7 days')
        OR (a.status = 'APPROVED' AND a.valid_until <= now())
     FOR UPDATE)
  UPDATE download_approvals a SET status = 'EXPIRED'
    FROM old WHERE a.id = old.id
  RETURNING a.id, a.document_id, a.requester_id, old.status
$$;
REVOKE ALL ON FUNCTION tv_expire_downloads() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_expire_downloads() TO trustvault_app;

-- End an exception early: the document's owner only.
CREATE FUNCTION tv_end_override(p_override uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE me uuid := tv_current_user();
BEGIN
  UPDATE access_overrides o SET revoked_at = now(), revoked_by_id = me
   WHERE o.id = p_override AND o.revoked_at IS NULL AND o.expires_at > now()
     AND me IS NOT NULL AND tv_doc_owner(o.document_id) = me;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION tv_end_override(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_end_override(uuid) TO trustvault_app;

-- Revoking a person's share cancels their open requests and approvals on
-- that document, so a later re-share does not quietly revive them.
CREATE FUNCTION grants_cancel_approvals() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.user_id IS NOT NULL THEN
    UPDATE download_approvals SET status = 'CANCELLED'
     WHERE document_id = OLD.document_id AND requester_id = OLD.user_id AND status IN ('PENDING', 'APPROVED');
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER grants_cancel_approvals AFTER DELETE ON "grants"
  FOR EACH ROW EXECUTE FUNCTION grants_cancel_approvals();

REVOKE ALL ON FUNCTION access_policy_guard(), access_overrides_guard(), download_approvals_guard_insert(), grants_cancel_approvals() FROM PUBLIC;

-- ---------- Facts for the application lock ----------
-- Same as 20261102200000, plus each grant's conditions, the role rules and
-- any live exception. Still facts only; decide() in TypeScript decides.
CREATE OR REPLACE FUNCTION tv_access_facts(p_doc uuid, p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'document', (SELECT jsonb_build_object('ownerId', d.owner_id, 'status', d.status)
                   FROM documents d WHERE d.id = p_doc),
    'user', (SELECT jsonb_build_object('role', u.role, 'status', u.status, 'accessExpiresAt', u.access_expires_at)
               FROM users u WHERE u.id = p_user),
    'grants', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'level', g.level, 'expiresAt', g.expires_at, 'viaGroup', g.group_id IS NOT NULL,
                 'downloadApproval', g.download_approval,
                 'window', CASE WHEN g.window_days IS NULL THEN NULL ELSE jsonb_build_object(
                             'days', to_jsonb(g.window_days), 'start', g.window_start_min, 'end', g.window_end_min, 'tz', g.window_tz) END,
                 'networks', to_jsonb(g.allowed_cidrs)))
          FROM grants g
         WHERE g.document_id = p_doc
           AND (g.user_id = p_user
                OR (EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.group_id AND gm.user_id = p_user)
                    AND EXISTS (SELECT 1 FROM grant_group_members c WHERE c.grant_id = g.id AND c.user_id = p_user)))), '[]'::jsonb),
    'breakGlassUntil', (SELECT max(b.expires_at) FROM break_glass b WHERE b.document_id = p_doc AND b.admin_id = p_user),
    'rolePolicy', (SELECT jsonb_build_object(
                     'window', CASE WHEN r.window_days IS NULL THEN NULL ELSE jsonb_build_object(
                                 'days', to_jsonb(r.window_days), 'start', r.window_start_min, 'end', r.window_end_min, 'tz', r.window_tz) END,
                     'networks', to_jsonb(r.allowed_cidrs))
                     FROM role_access_policies r JOIN users u ON u.role = r.role WHERE u.id = p_user),
    'overrideUntil', (SELECT max(o.expires_at) FROM access_overrides o
                       WHERE o.document_id = p_doc AND o.user_id = p_user AND o.revoked_at IS NULL)
  )
$$;
