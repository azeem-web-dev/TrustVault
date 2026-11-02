-- Second adversarial review, 2026-11-02 (THREATS.md A19, A20, A21, R9, R10).
--
-- 1. A19: admins control group membership. An admin could create a stand-in
--    account, add it to a group that already holds grants, sign in as it and
--    read those documents, with no break-glass and no owner involved. Now a
--    group grant covers only the members the sharer confirmed: when a group
--    is shared (or the share is confirmed again), its current members are
--    recorded in grant_group_members. Both locks require the person to be in
--    that list AND still in the group, so adding someone later needs the
--    owner (or a manager) to confirm, and removing someone still cuts them
--    off at once. Removal also drops them from every list, so being removed
--    and re-added does not quietly restore access.
--
-- 2. A20: a document created while its owner is being promoted could end up
--    owned by an admin; and an owner demoted to VIEWER or EXTERNAL kept full
--    owner power. Role changes away from OWNER are refused while the person
--    owns documents; document creation waits for and re-checks the owner's
--    role; admins never see a document through the owner branch.
--
-- 3. R10: expiry checks use clock_timestamp(), not the transaction start
--    time, so a grant that expires during a slow upload is not honoured at
--    the moment the version is written.
--
-- 4. A21: break-glass rows always start now (the client cannot set
--    created_at), and leaving the ADMIN role or being deactivated ends any
--    open window.

CREATE TABLE "grant_group_members" (
  "grant_id" UUID NOT NULL REFERENCES "grants"("id") ON DELETE CASCADE,
  "user_id"  UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "confirmed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "grant_group_members_pkey" PRIMARY KEY ("grant_id", "user_id")
);
CREATE INDEX "grant_group_members_user_id_idx" ON "grant_group_members"("user_id");
GRANT SELECT ON "grant_group_members" TO trustvault_app;  -- writes only through the functions below
ALTER TABLE "grant_group_members" ENABLE ROW LEVEL SECURITY;
-- People see their own coverage; managers of the document see all of it.
CREATE POLICY ggm_select ON "grant_group_members" FOR SELECT TO trustvault_app
  USING (user_id = tv_current_user()
         OR EXISTS (SELECT 1 FROM grants g WHERE g.id = grant_id AND tv_doc_level(g.document_id, tv_current_user()) >= 3));
-- Writes only through tv_confirm_group_members() below.

-- Existing group grants: their current members were in the group when this
-- rule arrived, so they stay covered (no one loses access by the upgrade).
INSERT INTO grant_group_members (grant_id, user_id)
SELECT g.id, gm.user_id
  FROM grants g JOIN group_members gm ON gm.group_id = g.group_id
  JOIN users u ON u.id = gm.user_id AND u.role NOT IN ('ADMIN', 'EXTERNAL')
 WHERE g.group_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Record who a group grant covers: the group's current members (never
-- admins or externals). Callable by the app role, but only by someone who
-- may share the document, checked here, not trusted from the caller.
CREATE FUNCTION tv_confirm_group_members(p_grant uuid, p_actor uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  g grants%ROWTYPE;
  n int;
BEGIN
  SELECT * INTO g FROM grants WHERE id = p_grant;
  IF NOT FOUND OR g.group_id IS NULL THEN RETURN 0; END IF;
  IF tv_doc_level(g.document_id, p_actor) < 3 THEN
    RAISE EXCEPTION 'only someone who can share this document can confirm its group members' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM grant_group_members WHERE grant_id = p_grant;
  INSERT INTO grant_group_members (grant_id, user_id)
  SELECT p_grant, gm.user_id FROM group_members gm JOIN users u ON u.id = gm.user_id
   WHERE gm.group_id = g.group_id AND u.role NOT IN ('ADMIN', 'EXTERNAL');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION tv_confirm_group_members(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_confirm_group_members(uuid, uuid) TO trustvault_app;

-- Leaving a group drops you from every grant list of that group.
CREATE FUNCTION group_members_forget() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM grant_group_members c USING grants g
   WHERE c.grant_id = g.id AND g.group_id = OLD.group_id AND c.user_id = OLD.user_id;
  RETURN OLD;
END
$$;
CREATE TRIGGER group_members_forget AFTER DELETE ON "group_members"
  FOR EACH ROW EXECUTE FUNCTION group_members_forget();

-- The database lock, now with confirmed group members and a live clock.
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

  -- Administrators: no ownership, no grants, no groups. Break-glass only.
  IF u_role = 'ADMIN' THEN
    IF d_status = 'ACTIVE' AND EXISTS (
         SELECT 1 FROM break_glass b WHERE b.document_id = p_doc AND b.admin_id = p_user AND b.expires_at > t) THEN
      RETURN 1;
    END IF;
    RETURN 0;
  END IF;

  IF d_owner = p_user THEN RETURN 4; END IF;     -- owners keep access to their own trash
  IF d_status <> 'ACTIVE' THEN RETURN 0; END IF; -- nobody else sees deleted documents

  SELECT coalesce(max(CASE g.level WHEN 'MANAGE' THEN 3 WHEN 'EDIT' THEN 2 ELSE 1 END), 0) INTO lvl
    FROM grants g
   WHERE g.document_id = p_doc
     AND (g.expires_at IS NULL OR g.expires_at > t)
     AND (g.user_id = p_user
          OR (u_role <> 'EXTERNAL'
              AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.group_id AND gm.user_id = p_user)
              AND EXISTS (SELECT 1 FROM grant_group_members c WHERE c.grant_id = g.id AND c.user_id = p_user)));

  IF u_role = 'EXTERNAL' THEN lvl := least(lvl, 1); END IF;  -- externals: read at most
  RETURN lvl;
END
$$;

-- The facts the application lock decides on: same group rule.
CREATE OR REPLACE FUNCTION tv_access_facts(p_doc uuid, p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'document', (SELECT jsonb_build_object('ownerId', d.owner_id, 'status', d.status)
                   FROM documents d WHERE d.id = p_doc),
    'user', (SELECT jsonb_build_object('role', u.role, 'status', u.status, 'accessExpiresAt', u.access_expires_at)
               FROM users u WHERE u.id = p_user),
    'grants', coalesce((
        SELECT jsonb_agg(jsonb_build_object('level', g.level, 'expiresAt', g.expires_at, 'viaGroup', g.group_id IS NOT NULL))
          FROM grants g
         WHERE g.document_id = p_doc
           AND (g.user_id = p_user
                OR (EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.group_id AND gm.user_id = p_user)
                    AND EXISTS (SELECT 1 FROM grant_group_members c WHERE c.grant_id = g.id AND c.user_id = p_user)))), '[]'::jsonb),
    'breakGlassUntil', (SELECT max(b.expires_at) FROM break_glass b WHERE b.document_id = p_doc AND b.admin_id = p_user)
  )
$$;

-- Members see a group grant only if it covers them.
DROP POLICY grants_select ON "grants";
CREATE POLICY grants_select ON "grants" FOR SELECT TO trustvault_app
  USING (user_id = tv_current_user()
         OR (EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = grants.group_id AND gm.user_id = tv_current_user())
             AND EXISTS (SELECT 1 FROM grant_group_members c WHERE c.grant_id = grants.id AND c.user_id = tv_current_user()))
         OR tv_doc_level(document_id, tv_current_user()) >= 3);

-- Admins never see a document through the owner branch.
DROP POLICY documents_select ON "documents";
CREATE POLICY documents_select ON "documents" FOR SELECT TO trustvault_app
  USING (
    (owner_id = tv_current_user()
       AND EXISTS (SELECT 1 FROM users u WHERE u.id = owner_id AND u.status = 'ACTIVE' AND u.role <> 'ADMIN'
                     AND (u.access_expires_at IS NULL OR u.access_expires_at > clock_timestamp())))
    OR tv_doc_level(id, tv_current_user()) >= 1
  );

-- Creating a document waits for any role change of its owner to finish,
-- then checks the role again (the insert policy alone reads it unlocked).
CREATE FUNCTION documents_owner_role_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.owner_id AND u.role = 'OWNER' AND u.status = 'ACTIVE' FOR SHARE) THEN
    RAISE EXCEPTION 'only an active document owner can own documents' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER documents_owner_role_guard BEFORE INSERT ON "documents"
  FOR EACH ROW EXECUTE FUNCTION documents_owner_role_guard();

-- Break-glass windows always start now.
CREATE FUNCTION break_glass_now() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  IF NEW.expires_at > now() + interval '61 minutes' THEN  -- one hour, plus a minute of clock difference
    RAISE EXCEPTION 'break-glass lasts at most one hour' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER break_glass_now BEFORE INSERT ON "break_glass"
  FOR EACH ROW EXECUTE FUNCTION break_glass_now();

-- After any role change (called by the API in the same transaction, after
-- the update, under the user row lock):
--   * leaving OWNER is refused while the person owns documents;
--   * becoming ADMIN or EXTERNAL drops their grants and group memberships
--     (an external's access must be given again, READ with an expiry);
--   * leaving ADMIN ends any open break-glass window.
CREATE FUNCTION tv_after_role_change(p_user uuid, p_from "Role") RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  new_role "Role";
  n_grants int := 0;
  n_groups int := 0;
  n_glass int := 0;
BEGIN
  SELECT role INTO new_role FROM users WHERE id = p_user;
  IF NOT FOUND OR new_role = p_from THEN
    RETURN jsonb_build_object('grantsRemoved', 0, 'groupsLeft', 0, 'breakGlassEnded', 0);
  END IF;
  IF p_from = 'OWNER' AND EXISTS (SELECT 1 FROM documents WHERE owner_id = p_user) THEN
    RAISE EXCEPTION 'transfer or delete this person''s documents before changing their role' USING ERRCODE = 'check_violation';
  END IF;
  IF new_role IN ('ADMIN', 'EXTERNAL') THEN
    DELETE FROM grants WHERE user_id = p_user;
    GET DIAGNOSTICS n_grants = ROW_COUNT;
    DELETE FROM group_members WHERE user_id = p_user;
    GET DIAGNOSTICS n_groups = ROW_COUNT;
  END IF;
  IF p_from = 'ADMIN' THEN
    UPDATE break_glass SET expires_at = now() WHERE admin_id = p_user AND expires_at > now();
    GET DIAGNOSTICS n_glass = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('grantsRemoved', n_grants, 'groupsLeft', n_groups, 'breakGlassEnded', n_glass);
END
$$;
REVOKE ALL ON FUNCTION tv_after_role_change(uuid, "Role") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_after_role_change(uuid, "Role") TO trustvault_app;
DROP FUNCTION tv_after_admin_promotion(uuid);

-- Deactivating an admin ends their break-glass windows.
CREATE FUNCTION tv_end_break_glass(p_user uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int;
BEGIN
  UPDATE break_glass SET expires_at = now() WHERE admin_id = p_user AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION tv_end_break_glass(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_end_break_glass(uuid) TO trustvault_app;

-- Ended sessions: the first request with one is recorded, later ones are not
-- recorded again, and the row stays until it expires (THREATS.md L10).
ALTER TABLE "sessions" ADD COLUMN "rejected_at" timestamptz(6);
