-- Holes found by an adversarial review on 2026-11-02 (THREATS.md A17, R7, R8):
--
-- 1. An administrator could read documents by adding themselves to a group
--    that held a grant, or by being promoted from a role that held grants.
--    Admins manage people, not documents: in this lock an ADMIN now gets
--    nothing from ownership or grants. Only an unexpired break-glass gives
--    READ. New grants to admins and admin group memberships are refused.
--
-- 2. Someone with MANAGE could share with a group they belong to; revoking
--    their own grant then left them access through that group. Only the
--    owner may now share with a group the sharer belongs to.

CREATE OR REPLACE FUNCTION tv_doc_level(p_doc uuid, p_user uuid) RETURNS int
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  u_role "Role";
  d_owner uuid;
  d_status "DocumentStatus";
  lvl int := 0;
BEGIN
  IF p_doc IS NULL OR p_user IS NULL THEN RETURN 0; END IF;

  SELECT role INTO u_role FROM users
   WHERE id = p_user AND status = 'ACTIVE' AND (access_expires_at IS NULL OR access_expires_at > now());
  IF NOT FOUND THEN RETURN 0; END IF;            -- deactivated, expired or unknown

  SELECT owner_id, status INTO d_owner, d_status FROM documents WHERE id = p_doc;
  IF NOT FOUND THEN RETURN 0; END IF;

  -- Administrators: no ownership, no grants, no groups. Break-glass only.
  IF u_role = 'ADMIN' THEN
    IF d_status = 'ACTIVE' AND EXISTS (
         SELECT 1 FROM break_glass b WHERE b.document_id = p_doc AND b.admin_id = p_user AND b.expires_at > now()) THEN
      RETURN 1;
    END IF;
    RETURN 0;
  END IF;

  IF d_owner = p_user THEN RETURN 4; END IF;     -- owners keep access to their own trash
  IF d_status <> 'ACTIVE' THEN RETURN 0; END IF; -- nobody else sees deleted documents

  SELECT coalesce(max(CASE g.level WHEN 'MANAGE' THEN 3 WHEN 'EDIT' THEN 2 ELSE 1 END), 0) INTO lvl
    FROM grants g
   WHERE g.document_id = p_doc
     AND (g.expires_at IS NULL OR g.expires_at > now())
     AND (g.user_id = p_user
          OR (u_role <> 'EXTERNAL' AND g.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = p_user)));

  IF u_role = 'EXTERNAL' THEN lvl := least(lvl, 1); END IF;  -- externals: read at most
  RETURN lvl;
END
$$;

CREATE OR REPLACE FUNCTION grants_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  granter_level int;
  target users%ROWTYPE;
BEGIN
  granter_level := tv_doc_level(NEW.document_id, NEW.granted_by_id);
  IF granter_level < 3 THEN
    RAISE EXCEPTION 'granter lacks MANAGE on this document' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.level = 'MANAGE' AND granter_level < 4 THEN
    RAISE EXCEPTION 'only the owner can grant MANAGE' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.user_id IS NOT NULL THEN
    SELECT * INTO target FROM users WHERE id = NEW.user_id;
    IF NOT FOUND OR target.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'cannot grant to an inactive or unknown user' USING ERRCODE = 'check_violation';
    END IF;
    IF target.role = 'ADMIN' THEN
      RAISE EXCEPTION 'administrators cannot be given document access' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM documents d WHERE d.id = NEW.document_id AND d.owner_id = NEW.user_id) THEN
      RAISE EXCEPTION 'the owner already has full access' USING ERRCODE = 'check_violation';
    END IF;
    IF target.role = 'EXTERNAL' AND (NEW.level <> 'READ' OR NEW.expires_at IS NULL) THEN
      RAISE EXCEPTION 'external users get READ only, with an expiry' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.group_id IS NOT NULL AND granter_level < 4 AND EXISTS (
       SELECT 1 FROM group_members gm WHERE gm.group_id = NEW.group_id AND gm.user_id = NEW.granted_by_id) THEN
    RAISE EXCEPTION 'only the owner can share with a group the sharer belongs to' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= now() THEN
    RAISE EXCEPTION 'expiry must be in the future' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION group_members_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.role = 'EXTERNAL') THEN
    RAISE EXCEPTION 'external users cannot be group members' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.role = 'ADMIN') THEN
    RAISE EXCEPTION 'administrators cannot be group members' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Promotion to ADMIN: refuse while the person owns documents (they would be
-- left with nobody able to open them), and drop the grants and group
-- memberships the person can no longer use, so "who has access" stays true.
-- Called by the API after the role update, in the same transaction; does
-- nothing unless the user really is an ADMIN now.
CREATE FUNCTION tv_after_admin_promotion(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n_grants int;
  n_groups int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user AND role = 'ADMIN') THEN
    RETURN jsonb_build_object('grantsRemoved', 0, 'groupsLeft', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM documents WHERE owner_id = p_user) THEN
    RAISE EXCEPTION 'transfer or delete this person''s documents before making them an administrator' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM grants WHERE user_id = p_user;
  GET DIAGNOSTICS n_grants = ROW_COUNT;
  DELETE FROM group_members WHERE user_id = p_user;
  GET DIAGNOSTICS n_groups = ROW_COUNT;
  RETURN jsonb_build_object('grantsRemoved', n_grants, 'groupsLeft', n_groups);
END
$$;
REVOKE ALL ON FUNCTION tv_after_admin_promotion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_after_admin_promotion(uuid) TO trustvault_app;

-- Admins already holding grants or memberships (from before this fix).
DELETE FROM grants g USING users u WHERE g.user_id = u.id AND u.role = 'ADMIN';
DELETE FROM group_members m USING users u WHERE m.user_id = u.id AND u.role = 'ADMIN';

-- Ended sessions are marked, not deleted, so a later attempt with one is
-- recorded in the audit log with why it had ended (THREATS.md L10).
ALTER TABLE "sessions" ADD COLUMN "revoked_at" timestamptz(6), ADD COLUMN "revoked_reason" text;
