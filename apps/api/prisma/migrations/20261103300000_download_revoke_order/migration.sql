-- Downloads and the changes that take access away happen in one order
-- (THREATS.md R11).
--
-- Before this, only changes took the per-document lock. A download checked
-- access, fetched the sealed file, then wrote its ALLOWED audit row; a revoke
-- that committed in between left a download decided on the old state but
-- recorded AFTER the revoke. Now:
--
--   * a view or download takes a SHARED lock on its user, then on the
--     document, before deciding, and keeps both until commit (the decision,
--     the version fetch and the audit row all happen under them);
--   * every change that can give or take away access takes the matching
--     EXCLUSIVE lock before its first write, and keeps it until commit.
--
-- So a download and a revoke never overlap: one finishes, audit row
-- included, before the other starts. Downloads share the lock, so they still
-- run side by side.
--
-- Two kinds of lock, because some changes touch one document and some touch
-- one person on every document they can reach:
--   document lock  pg_advisory_xact_lock(hashtextextended(doc id, 0))  (as before)
--   user lock      pg_advisory_xact_lock(7310100, hashtext(user id))
-- Order, everywhere: user locks, then users row locks, then document locks,
-- then the audit chain lock (7310001), which is always last. Code that locks
-- several users or documents locks them in id order. The triggers below take
-- the same locks as a backstop, so a path that forgets still serialises
-- correctly; it can only risk a deadlock, which Postgres detects and breaks.

-- ---------- The two locks ----------
CREATE FUNCTION tv_lock_doc(p_doc uuid, p_exclusive boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_doc IS NULL THEN RETURN; END IF;
  IF p_exclusive THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_doc::text, 0));
  ELSE
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_doc::text, 0));
  END IF;
END
$$;

CREATE FUNCTION tv_lock_user(p_user uuid, p_exclusive boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_user IS NULL THEN RETURN; END IF;
  IF p_exclusive THEN
    PERFORM pg_advisory_xact_lock(7310100, hashtext(p_user::text));
  ELSE
    PERFORM pg_advisory_xact_lock_shared(7310100, hashtext(p_user::text));
  END IF;
END
$$;

-- What every document request takes first (AccessService.require): its
-- user's lock shared, then the document's lock, shared for reading and
-- exclusive for changing. One call so the order cannot be got wrong.
CREATE FUNCTION tv_lock_access(p_user uuid, p_doc uuid, p_exclusive boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM tv_lock_user(p_user, false);
  PERFORM tv_lock_doc(p_doc, p_exclusive);
END
$$;

-- Deleting a group: every member, then every document shared with it, in
-- id order, before the cascade takes them one by one in no fixed order.
CREATE FUNCTION tv_lock_group(p_group uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT user_id FROM group_members WHERE group_id = p_group ORDER BY user_id LOOP
    PERFORM tv_lock_user(r.user_id, true);
  END LOOP;
  FOR r IN SELECT DISTINCT document_id FROM grants WHERE group_id = p_group ORDER BY document_id LOOP
    PERFORM tv_lock_doc(r.document_id, true);
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION tv_lock_doc(uuid, boolean), tv_lock_user(uuid, boolean), tv_lock_access(uuid, uuid, boolean), tv_lock_group(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_lock_doc(uuid, boolean), tv_lock_user(uuid, boolean), tv_lock_access(uuid, uuid, boolean), tv_lock_group(uuid) TO trustvault_app;

-- ---------- Backstop: every access-changing write takes its lock ----------
-- Named "<table>_0_lock" so they fire before the tables' other BEFORE
-- triggers (Postgres fires them in name order): rules are checked under the lock.

-- Grants and their expiry: one document.
CREATE FUNCTION tv_lock_grant_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM tv_lock_doc(OLD.document_id, true); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM tv_lock_doc(NEW.document_id, true); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER grants_0_lock BEFORE INSERT OR UPDATE OR DELETE ON "grants"
  FOR EACH ROW EXECUTE FUNCTION tv_lock_grant_change();

-- Group membership: one person, on every document shared with the group.
CREATE FUNCTION tv_lock_member_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM tv_lock_user(OLD.user_id, true); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM tv_lock_user(NEW.user_id, true); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER group_members_0_lock BEFORE INSERT OR UPDATE OR DELETE ON "group_members"
  FOR EACH ROW EXECUTE FUNCTION tv_lock_member_change();

-- Break-glass windows opening or ending: one document.
CREATE FUNCTION tv_lock_break_glass_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN PERFORM tv_lock_doc(OLD.document_id, true); END IF;
  PERFORM tv_lock_doc(NEW.document_id, true);
  RETURN NEW;
END
$$;
CREATE TRIGGER break_glass_0_lock BEFORE INSERT OR UPDATE ON "break_glass"
  FOR EACH ROW EXECUTE FUNCTION tv_lock_break_glass_change();

-- Trash, restore, transfer and permanent deletion: one document.
CREATE FUNCTION tv_lock_document_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM tv_lock_doc(OLD.id, true);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER documents_0_lock BEFORE UPDATE ON "documents"
  FOR EACH ROW WHEN (OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION tv_lock_document_change();
CREATE TRIGGER documents_0_lock_delete BEFORE DELETE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION tv_lock_document_change();

-- Role, status, access end date and password: one person, everywhere. (A
-- password change ends their sessions, which require() re-checks.)
CREATE FUNCTION tv_lock_user_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM tv_lock_user(OLD.id, true);
  RETURN NEW;
END
$$;
CREATE TRIGGER users_0_lock BEFORE UPDATE ON "users"
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.status IS DISTINCT FROM NEW.status
                     OR OLD.access_expires_at IS DISTINCT FROM NEW.access_expires_at
                     OR OLD.password_changed_at IS DISTINCT FROM NEW.password_changed_at)
  EXECUTE FUNCTION tv_lock_user_change();

-- A version found infected: downloads of it stop, in order with them.
CREATE FUNCTION tv_lock_quarantine() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM tv_lock_doc((SELECT v.document_id FROM document_versions v WHERE v.id = NEW.version_id), true);
  RETURN NEW;
END
$$;
CREATE TRIGGER version_quarantine_0_lock BEFORE INSERT ON "version_quarantine"
  FOR EACH ROW EXECUTE FUNCTION tv_lock_quarantine();

REVOKE ALL ON FUNCTION tv_lock_grant_change(), tv_lock_member_change(), tv_lock_break_glass_change(),
  tv_lock_document_change(), tv_lock_user_change(), tv_lock_quarantine() FROM PUBLIC;

-- ---------- Functions that change several documents lock them in order ----------
-- Confirming a group's members: the document's lock (the API already holds it).
CREATE OR REPLACE FUNCTION tv_confirm_group_members(p_grant uuid, p_actor uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  g grants%ROWTYPE;
  n int;
BEGIN
  SELECT * INTO g FROM grants WHERE id = p_grant;
  IF NOT FOUND OR g.group_id IS NULL THEN RETURN 0; END IF;
  PERFORM tv_lock_doc(g.document_id, true);
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

-- After a role change (the API holds the person's lock): their documents'
-- locks in id order before their grants go and their break-glass ends.
CREATE OR REPLACE FUNCTION tv_after_role_change(p_user uuid, p_from "Role") RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  new_role "Role";
  n_grants int := 0;
  n_groups int := 0;
  n_glass int := 0;
  r record;
BEGIN
  SELECT role INTO new_role FROM users WHERE id = p_user;
  IF NOT FOUND OR new_role = p_from THEN
    RETURN jsonb_build_object('grantsRemoved', 0, 'groupsLeft', 0, 'breakGlassEnded', 0);
  END IF;
  PERFORM tv_lock_user(p_user, true);
  IF p_from = 'OWNER' AND EXISTS (SELECT 1 FROM documents WHERE owner_id = p_user) THEN
    RAISE EXCEPTION 'transfer or delete this person''s documents before changing their role' USING ERRCODE = 'check_violation';
  END IF;
  FOR r IN SELECT document_id FROM grants WHERE user_id = p_user AND new_role IN ('ADMIN', 'EXTERNAL')
           UNION SELECT document_id FROM break_glass WHERE admin_id = p_user AND p_from = 'ADMIN' AND expires_at > now()
           ORDER BY 1 LOOP
    PERFORM tv_lock_doc(r.document_id, true);
  END LOOP;
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

CREATE OR REPLACE FUNCTION tv_end_break_glass(p_user uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n int;
  r record;
BEGIN
  PERFORM tv_lock_user(p_user, true);
  FOR r IN SELECT DISTINCT document_id FROM break_glass WHERE admin_id = p_user AND expires_at > now() ORDER BY document_id LOOP
    PERFORM tv_lock_doc(r.document_id, true);
  END LOOP;
  UPDATE break_glass SET expires_at = now() WHERE admin_id = p_user AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Retention purge: each document's lock, in id order, before it goes.
DROP FUNCTION tv_purge_expired_trash(int);
CREATE FUNCTION tv_purge_expired_trash(p_days int)
RETURNS TABLE (id uuid, owner_id uuid, title text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT d.id FROM documents d
            WHERE d.status = 'DELETED' AND d.deleted_at < now() - make_interval(days => greatest(p_days, 1))
            ORDER BY d.id LOOP
    PERFORM tv_lock_doc(r.id, true);
  END LOOP;
  RETURN QUERY
    DELETE FROM documents d
     WHERE d.status = 'DELETED' AND d.deleted_at < now() - make_interval(days => greatest(p_days, 1))
    RETURNING d.id, d.owner_id, d.title;
END
$$;
REVOKE ALL ON FUNCTION tv_purge_expired_trash(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_purge_expired_trash(int) TO trustvault_app;

-- ---------- The ALLOWED row is written only while access still holds ----------
-- Expiry is the one change nobody commits, so no lock can order it. The
-- database checks access again as it writes a download's ALLOWED row, after
-- the chain trigger has stamped occurred_at, using the live clock: every
-- ALLOWED download row is therefore dated before the grant or account
-- expired. If access lapsed between the check and the row, the insert fails,
-- the transaction rolls back, and nothing is sent.
-- (Named to fire after audit_events_chain, which sets occurred_at.)
CREATE FUNCTION audit_download_still_allowed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF tv_doc_level(NEW.document_id, NEW.actor_id) < 1 THEN
    RAISE EXCEPTION 'download refused: access ended during the request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION audit_download_still_allowed() FROM PUBLIC;
CREATE TRIGGER audit_events_download_live BEFORE INSERT ON "audit_events"
  FOR EACH ROW WHEN (NEW.action = 'document.download' AND NEW.outcome = 'ALLOWED')
  EXECUTE FUNCTION audit_download_still_allowed();
