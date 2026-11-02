-- View-only access (THREATS.md V1-V10).
--
-- Levels are renumbered so VIEW fits below READ. The app's Level enum
-- (src/documents/access.ts) uses the same numbers; both locks must agree:
--   0 none, 1 VIEW, 2 READ, 3 EDIT, 4 MANAGE, 5 owner.
-- VIEW sees the document, its versions and its rendered pages. Original
-- bytes (document_blobs) need READ, here and in decide().

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
              AND EXISTS (SELECT 1 FROM grant_group_members c WHERE c.grant_id = g.id AND c.user_id = p_user)));

  IF u_role = 'EXTERNAL' THEN lvl := least(lvl, 2); END IF;  -- externals: READ at most
  RETURN lvl;
END
$$;

-- ---------- Row-level security, renumbered ----------
-- documents_select keeps ">= 1": VIEW sees the document and its versions.
DROP POLICY documents_update ON "documents";
CREATE POLICY documents_update ON "documents" FOR UPDATE TO trustvault_app
  USING (tv_doc_level(id, tv_current_user()) >= 3)
  WITH CHECK (true);  -- column-level rules: documents_guard_update

DROP POLICY versions_insert ON "document_versions";
CREATE POLICY versions_insert ON "document_versions" FOR INSERT TO trustvault_app
  WITH CHECK (uploaded_by_id = tv_current_user() AND tv_doc_level(document_id, tv_current_user()) >= 3);

-- The original bytes: READ or better. A VIEW grantee gets no blob row,
-- whatever the app asks for (THREATS.md V1).
DROP POLICY blobs_select ON "document_blobs";
CREATE POLICY blobs_select ON "document_blobs" FOR SELECT TO trustvault_app
  USING (EXISTS (SELECT 1 FROM document_versions v WHERE v.id = version_id AND tv_doc_level(v.document_id, tv_current_user()) >= 2));
DROP POLICY blobs_insert ON "document_blobs";
CREATE POLICY blobs_insert ON "document_blobs" FOR INSERT TO trustvault_app
  WITH CHECK (EXISTS (SELECT 1 FROM document_versions v WHERE v.id = version_id AND tv_doc_level(v.document_id, tv_current_user()) >= 3));

DROP POLICY grants_select ON "grants";
CREATE POLICY grants_select ON "grants" FOR SELECT TO trustvault_app
  USING (user_id = tv_current_user()
         OR (EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = grants.group_id AND gm.user_id = tv_current_user())
             AND EXISTS (SELECT 1 FROM grant_group_members c WHERE c.grant_id = grants.id AND c.user_id = tv_current_user()))
         OR tv_doc_level(document_id, tv_current_user()) >= 4);
DROP POLICY grants_insert ON "grants";
CREATE POLICY grants_insert ON "grants" FOR INSERT TO trustvault_app
  WITH CHECK (granted_by_id = tv_current_user() AND tv_doc_level(document_id, tv_current_user()) >= 4);
DROP POLICY grants_update ON "grants";
CREATE POLICY grants_update ON "grants" FOR UPDATE TO trustvault_app
  USING (tv_doc_level(document_id, tv_current_user()) >= 4)
  WITH CHECK (granted_by_id = tv_current_user() AND tv_doc_level(document_id, tv_current_user()) >= 4);
DROP POLICY grants_delete ON "grants";
CREATE POLICY grants_delete ON "grants" FOR DELETE TO trustvault_app
  USING (tv_doc_level(document_id, tv_current_user()) >= 4);

DROP POLICY break_glass_select ON "break_glass";
CREATE POLICY break_glass_select ON "break_glass" FOR SELECT TO trustvault_app
  USING (admin_id = tv_current_user() OR tv_doc_level(document_id, tv_current_user()) >= 4);

CREATE OR REPLACE FUNCTION tv_grant_manageable(p_grant uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT tv_doc_level(g.document_id, p_user) >= 4 FROM grants g WHERE g.id = p_grant), false)
$$;

CREATE OR REPLACE FUNCTION tv_confirm_group_members(p_grant uuid, p_actor uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  g grants%ROWTYPE;
  n int;
BEGIN
  SELECT * INTO g FROM grants WHERE id = p_grant;
  IF NOT FOUND OR g.group_id IS NULL THEN RETURN 0; END IF;
  IF tv_doc_level(g.document_id, p_actor) < 4 THEN
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

-- Externals may now get VIEW or READ (still with an expiry).
CREATE OR REPLACE FUNCTION grants_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  granter_level int;
  target users%ROWTYPE;
BEGIN
  granter_level := tv_doc_level(NEW.document_id, NEW.granted_by_id);
  IF granter_level < 4 THEN
    RAISE EXCEPTION 'granter lacks MANAGE on this document' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.level = 'MANAGE' AND granter_level < 5 THEN
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
    IF target.role = 'EXTERNAL' AND (NEW.level NOT IN ('VIEW', 'READ') OR NEW.expires_at IS NULL) THEN
      RAISE EXCEPTION 'external users get VIEW or READ only, with an expiry' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.group_id IS NOT NULL AND granter_level < 5 AND EXISTS (
       SELECT 1 FROM group_members gm WHERE gm.group_id = NEW.group_id AND gm.user_id = NEW.granted_by_id) THEN
    RAISE EXCEPTION 'only the owner can share with a group the sharer belongs to' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= now() THEN
    RAISE EXCEPTION 'expiry must be in the future' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------- Rendering source for view-only pages ----------
-- The server must decrypt a file to draw its pages, including for a VIEW
-- grantee who cannot read document_blobs. This function hands over the
-- encrypted blob for that one purpose, only when the CURRENT user has at
-- least VIEW on the document (live, like every other check) and the
-- version is not quarantined. The app never sends its output; pages are
-- re-drawn as watermarked images (THREATS.md V2, A18).
CREATE FUNCTION tv_render_source(p_version uuid)
RETURNS TABLE(document_id uuid, version_no int, mime_type text, wrapped_key bytea, key_id text, nonce bytea, auth_tag bytea, ciphertext bytea, sha256 bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT v.document_id, v.version_no, v.mime_type, b.wrapped_key, b.key_id, b.nonce, b.auth_tag, b.ciphertext, v.sha256
    FROM document_versions v JOIN document_blobs b ON b.version_id = v.id
   WHERE v.id = p_version
     AND tv_doc_level(v.document_id, tv_current_user()) >= 1
     AND NOT EXISTS (SELECT 1 FROM version_quarantine q WHERE q.version_id = v.id)
$$;
REVOKE ALL ON FUNCTION tv_render_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_render_source(uuid) TO trustvault_app;

-- ---------- Keys for the Android app's encrypted copies ----------
-- One random key per (document, person), wrapped by keyd. The phone keeps
-- only the encrypted file; it asks for the key on every open. READ or
-- better only (VIEW gets no copy at all), and the key is destroyed when
-- that access ends, so a copy left on a phone cannot be opened again
-- (THREATS.md V6).
CREATE TABLE "offline_keys" (
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "wrapped_key" bytea NOT NULL,
  "key_id"      text NOT NULL,
  "created_at"  timestamptz(6) NOT NULL DEFAULT now(),
  PRIMARY KEY ("document_id", "user_id")
);
GRANT SELECT, INSERT ON "offline_keys" TO trustvault_app;
ALTER TABLE "offline_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY offline_keys_select ON "offline_keys" FOR SELECT TO trustvault_app
  USING (user_id = tv_current_user() AND tv_doc_level(document_id, user_id) >= 2);
CREATE POLICY offline_keys_insert ON "offline_keys" FOR INSERT TO trustvault_app
  WITH CHECK (user_id = tv_current_user() AND tv_doc_level(document_id, user_id) >= 2);

-- When a grant is removed or lowered, keys of anyone now below READ go.
-- Runs after the change, so tv_doc_level() already sees the new state.
CREATE FUNCTION offline_keys_forget() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM offline_keys k WHERE k.document_id = OLD.document_id AND tv_doc_level(k.document_id, k.user_id) < 2;
  RETURN NULL;
END
$$;
CREATE TRIGGER offline_keys_forget AFTER DELETE OR UPDATE ON "grants"
  FOR EACH ROW EXECUTE FUNCTION offline_keys_forget();
