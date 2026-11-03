-- View-only (20261103200100) renumbered the access levels:
--   0 none, 1 VIEW, 2 READ, 3 EDIT, 4 MANAGE, 5 owner.
-- The download/revoke ordering migration (20261103300000) was written
-- against the old numbers (1 READ, 3 MANAGE) and, being later, would
-- redefine two functions with them on a fresh database. Whatever order the
-- two were applied in, this migration leaves the final, renumbered versions
-- (THREATS.md R11, V1).

-- Confirming a group's members: MANAGE (4), under the document's lock.
CREATE OR REPLACE FUNCTION tv_confirm_group_members(p_grant uuid, p_actor uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  g grants%ROWTYPE;
  n int;
BEGIN
  SELECT * INTO g FROM grants WHERE id = p_grant;
  IF NOT FOUND OR g.group_id IS NULL THEN RETURN 0; END IF;
  PERFORM tv_lock_doc(g.document_id, true);
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

-- The ALLOWED row is written only while access still holds, at the level
-- the action needs: a download or an Android key needs READ (2), a page
-- view needs VIEW (1). Before, a VIEW grantee would have passed the
-- download check (">= 1"), and page views and keys were not checked at all.
CREATE OR REPLACE FUNCTION audit_download_still_allowed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  needed int := CASE NEW.action WHEN 'document.page_view' THEN 1 ELSE 2 END;
BEGIN
  IF tv_doc_level(NEW.document_id, NEW.actor_id) < needed THEN
    RAISE EXCEPTION 'download refused: access ended during the request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION audit_download_still_allowed() FROM PUBLIC;
DROP TRIGGER audit_events_download_live ON "audit_events";
CREATE TRIGGER audit_events_download_live BEFORE INSERT ON "audit_events"
  FOR EACH ROW WHEN (NEW.action IN ('document.download', 'document.page_view', 'document.offline_key') AND NEW.outcome = 'ALLOWED')
  EXECUTE FUNCTION audit_download_still_allowed();
