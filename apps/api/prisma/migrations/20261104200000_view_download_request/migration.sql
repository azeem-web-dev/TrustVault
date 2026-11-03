-- VIEW-holder download by owner approval (THREATS.md V1, P8-P10).
--
-- Before: a VIEW grantee could never obtain the original bytes. "downloads
-- need approval" only applied to holders who already had the download right
-- (READ, EDIT, MANAGE): the approval relaxed a condition on a right they had.
--
-- Now a VIEW-only grantee may ASK the owner (or a manager the owner nominated
-- on a share that covers them) for permission to download ONE document, and,
-- once approved, download THAT document+version only. Everything else about
-- their VIEW access is unchanged, and a VIEW holder with no usable approval is
-- still refused the bytes everywhere.
--
-- The download level requirement is NOT lowered. The ticketed `download`
-- action still needs READ (unwrap_actions.min_level = 2); the blob policy and
-- the keyd ticket mint still refuse everyone else. What changes is a single,
-- narrow authorisation, enforced identically in all three locks:
--
--   an APPROVED, unexpired, uses-remaining download_approval, bound to this
--   user + this version, authorises the `download` action for that one
--   version regardless of the holder's base level.
--
-- It flows through:
--   * the app lock (access.ts decide(): a VIEW holder with a usable approval
--     passes require(..., 'download'); without one, still refused);
--   * tv_consume_download(): spends exactly one use of that approval, still
--     requiring LIVE access to the document (tv_doc_level >= 1 VIEW), so a
--     revoked grant, an ended window or an expired account cuts it off at once;
--   * tv_blob_release_ok() (unchanged): releases the blob row only to the
--     transaction that consumed the approval;
--   * tv_issue_unwrap_ticket(): mints the keyd `download` ticket for a holder
--     below READ only when that same transaction has just consumed a usable
--     approval for this exact version (tv_download_approval_in_tx()).
--
-- Revocation (guarantee #3) still holds: deleting the VIEW grant cancels the
-- approvals (grants_cancel_approvals, unchanged); the window/expiry drop
-- tv_doc_level to 0, which tv_consume_download re-checks under FOR UPDATE.
-- Audit (guarantee #2) is unchanged: request, approve/reject and each use are
-- audited as today and appear in the document history the owner sees.

-- ---------- A request may now be opened by a VIEW holder ----------
-- The insert policy floor drops from READ (>= 2) to VIEW (>= 1). A VIEW holder
-- always needs approval to download, so letting them ask changes nothing about
-- what they can take. requester_id = tv_current_user() is unchanged, so nobody
-- asks in another person's name, and NONE (level 0) still cannot insert. An
-- administrator's only view is break-glass VIEW (an emergency look, THREATS.md
-- V9); they are excluded, so break-glass can never become a download.
DROP POLICY approvals_insert ON "download_approvals";
CREATE POLICY approvals_insert ON "download_approvals" FOR INSERT TO trustvault_app
  WITH CHECK (requester_id = tv_current_user() AND tv_doc_level(document_id, tv_current_user()) >= 1  -- VIEW: may ask; the bytes still need an approval
              AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = tv_current_user() AND u.role = 'ADMIN'));

-- ---------- Was an approval consumed in THIS transaction? ----------
-- The same predicate tv_blob_release_ok() uses, as a named helper: an approval
-- for this user and version, approved and unexpired, whose last use happened in
-- the current transaction. Ties a below-READ download ticket to the approval
-- that was actually spent for it, for this exact version.
CREATE FUNCTION tv_download_approval_in_tx(p_version uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM download_approvals a
     WHERE a.version_id = p_version AND a.requester_id = p_user
       AND a.status IN ('APPROVED', 'USED') AND a.valid_until > clock_timestamp()
       AND a.last_use_tx IS NOT NULL AND a.last_use_tx = txid_current_if_assigned());
$$;
REVOKE ALL ON FUNCTION tv_download_approval_in_tx(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_download_approval_in_tx(uuid, uuid) TO trustvault_app;

-- ---------- The blob row is visible to an approved VIEW holder, in-tx ----------
-- As 20261103200100, but a holder below READ may also see the blob row of a
-- version they have just spent an approval on in this transaction. A VIEW
-- grantee with NO such approval still gets no blob row (THREATS.md V1); the
-- RESTRICTIVE blobs_release policy (tv_blob_release_ok, unchanged) still has to
-- agree, so both locks release the bytes only to the consuming transaction.
DROP POLICY blobs_select ON "document_blobs";
CREATE POLICY blobs_select ON "document_blobs" FOR SELECT TO trustvault_app
  USING (EXISTS (SELECT 1 FROM document_versions v WHERE v.id = version_id
                  AND (tv_doc_level(v.document_id, tv_current_user()) >= 2
                       OR (tv_doc_level(v.document_id, tv_current_user()) >= 1
                           AND tv_download_approval_in_tx(version_id, tv_current_user())))));

-- ---------- Spending a use no longer needs READ, only live access ----------
-- As 20261103600000, but the floor is VIEW (>= 1) instead of READ (>= 2): the
-- approval itself authorises the download; tv_doc_level is only the liveness
-- check (revoked / out-of-window / expired => 0 => refused). A READ+ holder is
-- >= 2 >= 1, so their behaviour is unchanged; a below-VIEW holder still fails.
CREATE OR REPLACE FUNCTION tv_consume_download(p_request uuid, p_version uuid) RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  me uuid := tv_current_user();
  a download_approvals%ROWTYPE;
BEGIN
  SELECT * INTO a FROM download_approvals
   WHERE id = p_request AND requester_id = me AND version_id = p_version FOR UPDATE;
  IF NOT FOUND OR a.status <> 'APPROVED' OR a.valid_until <= clock_timestamp() OR a.uses >= a.max_uses
     OR tv_doc_level(a.document_id, me) < 1   -- VIEW: still a live grant on the document
     OR EXISTS (SELECT 1 FROM users u WHERE u.id = me AND u.role = 'ADMIN') THEN  -- never an admin (break-glass is VIEW only, V9)
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

-- ---------- The keyd download ticket, for a below-READ holder with an approval ----------
-- As 20261103400000, but the `download` action's level check accepts a holder
-- below READ when this transaction has just consumed a usable approval for the
-- exact version (tv_download_approval_in_tx). min_level stays 2 for everyone
-- else and for every other action (offline_key still needs READ, so a VIEW
-- holder with a download approval still cannot mint an offline key).
CREATE OR REPLACE FUNCTION tv_issue_unwrap_ticket(p_version uuid, p_action text, p_audit_event uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  a unwrap_actions;
  v record;
  e record;
  u uuid := tv_current_user();
  t timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO a FROM unwrap_actions WHERE action = p_action;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unwrap ticket refused: unknown action' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT dv.document_id, dv.version_no INTO v FROM document_versions dv WHERE dv.id = p_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unwrap ticket refused: no such version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF a.system THEN
    IF u IS NOT NULL THEN
      RAISE EXCEPTION 'unwrap ticket refused: system action inside a user transaction' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF u IS NULL
     OR (tv_doc_level(v.document_id, u) < a.min_level
         -- A holder below READ may still mint a `download` ticket if they have
         -- just spent an owner-approved download of this exact version in this
         -- transaction (THREATS.md V1): the approval authorises the one file.
         AND NOT (p_action = 'download' AND tv_download_approval_in_tx(p_version, u))) THEN
    RAISE EXCEPTION 'unwrap ticket refused: no access' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF a.refuse_quarantined AND EXISTS (SELECT 1 FROM version_quarantine q WHERE q.version_id = p_version) THEN
    RAISE EXCEPTION 'unwrap ticket refused: quarantined' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT ae.id, ae.seq, ae.action, ae.outcome, ae.document_id, ae.actor_id, ae.occurred_at, ae.details INTO e
    FROM audit_events ae WHERE ae.id = p_audit_event;
  IF NOT FOUND
     OR e.action <> a.audit_action
     OR e.outcome <> 'ALLOWED'
     OR e.document_id IS DISTINCT FROM v.document_id
     OR e.actor_id IS DISTINCT FROM u
     OR e.occurred_at < t - interval '60 seconds'
     OR (e.details ->> 'versionNo') IS DISTINCT FROM v.version_no::text THEN
    RAISE EXCEPTION 'unwrap ticket refused: no matching audit event' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM unwrap_tickets x WHERE x.audit_event_id = p_audit_event) THEN
    RAISE EXCEPTION 'unwrap ticket refused: audit event already used' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN tv_mint_unwrap_ticket(p_action, p_version, u, e.id, e.seq);
END
$$;

-- ---------- The ALLOWED-download backstop accepts an approved VIEW holder ----------
-- As 20261103330100, but an ALLOWED `document.download` row may also be written
-- by a holder below READ when they have just spent an owner-approved download of
-- that exact version in this transaction (THREATS.md R11, V1). Everyone else
-- still needs the action's live level (download/offline_key READ, page_view
-- VIEW), so a grant that lapsed mid-request is still refused here.
CREATE OR REPLACE FUNCTION audit_download_still_allowed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  needed int := CASE NEW.action WHEN 'document.page_view' THEN 1 ELSE 2 END;
BEGIN
  IF tv_doc_level(NEW.document_id, NEW.actor_id) < needed THEN
    -- A VIEW holder (live grant, level >= 1) who consumed a usable approval for
    -- this version in this transaction may record the ALLOWED download row.
    IF NEW.action = 'document.download' AND NEW.actor_id IS NOT NULL
       AND tv_doc_level(NEW.document_id, NEW.actor_id) >= 1
       AND tv_download_approval_in_tx(
             (SELECT v.id FROM document_versions v
               WHERE v.document_id = NEW.document_id AND v.version_no = (NEW.details ->> 'versionNo')::int),
             NEW.actor_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'download refused: access ended during the request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

-- ---------- Facts for the application lock: add a download summary ----------
-- As 20261103600000, plus a `download` object the app's decide()/downloadView()
-- read: whether the user has a usable approval (any version, and the current
-- version), the state of their latest request for the current version, whether
-- the current version is quarantined, and whether an approver exists. Still
-- facts only; the TypeScript decides.
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
                       WHERE o.document_id = p_doc AND o.user_id = p_user AND o.revoked_at IS NULL),
    'download', jsonb_build_object(
      -- A usable, owner-approved download request (approved, unexpired, with a
      -- use left). usableAny lets a VIEW holder past require(..., 'download')
      -- so they can consume for the exact version they ask for; usableCurrent
      -- and latestCurrentStatus describe the current version for the response.
      'usableAny', EXISTS (SELECT 1 FROM download_approvals a
                            WHERE a.document_id = p_doc AND a.requester_id = p_user
                              AND a.status = 'APPROVED' AND a.valid_until > now() AND a.uses < coalesce(a.max_uses, 0)),
      'usableCurrent', EXISTS (SELECT 1 FROM download_approvals a
                                WHERE a.requester_id = p_user
                                  AND a.version_id = (SELECT v.id FROM document_versions v JOIN documents d ON d.id = v.document_id
                                                       WHERE v.document_id = p_doc AND v.version_no = d.current_version_no)
                                  AND a.status = 'APPROVED' AND a.valid_until > now() AND a.uses < coalesce(a.max_uses, 0)),
      'latestCurrentStatus', coalesce((
          SELECT CASE WHEN a.status IN ('PENDING', 'APPROVED', 'REJECTED') THEN a.status::text ELSE 'NONE' END
            FROM download_approvals a
           WHERE a.requester_id = p_user
             AND a.version_id = (SELECT v.id FROM document_versions v JOIN documents d ON d.id = v.document_id
                                  WHERE v.document_id = p_doc AND v.version_no = d.current_version_no)
           ORDER BY a.created_at DESC LIMIT 1), 'NONE'),
      'currentQuarantined', EXISTS (SELECT 1 FROM version_quarantine q
                                     WHERE q.version_id = (SELECT v.id FROM document_versions v JOIN documents d ON d.id = v.document_id
                                                            WHERE v.document_id = p_doc AND v.version_no = d.current_version_no)),
      'approverExists', (tv_doc_owner(p_doc) IS NOT NULL
                          OR EXISTS (SELECT 1 FROM grants g WHERE g.document_id = p_doc AND g.download_approval AND g.download_approver_id IS NOT NULL))
    )
  )
$$;
