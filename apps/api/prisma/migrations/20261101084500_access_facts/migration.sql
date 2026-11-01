-- Raw access facts for the TypeScript decide() function.
--
-- tv_doc_level() (previous migration) decides access inside the database
-- for row-level security. decide() in the API must reach its own decision,
-- independently, so a mistake in one is caught by the other. This function
-- therefore returns only facts — who owns the document, its status, the
-- caller's account state, every grant that names the caller or one of the
-- caller's groups (expired ones included), and any break-glass window —
-- and makes no decision at all. Expiry, group rules for external users,
-- the deleted-document rule and the action-to-level mapping are applied in
-- TypeScript.
CREATE FUNCTION tv_access_facts(p_doc uuid, p_user uuid) RETURNS jsonb
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
                OR g.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = p_user))), '[]'::jsonb),
    'breakGlassUntil', (SELECT max(b.expires_at) FROM break_glass b WHERE b.document_id = p_doc AND b.admin_id = p_user)
  )
$$;
GRANT EXECUTE ON FUNCTION tv_access_facts(uuid, uuid) TO trustvault_app;

-- Fix: members of a group must be able to see grants made to that group,
-- otherwise "shared with me" search misses every document shared through a
-- group. Seeing the grant row reveals only that the group has access.
DROP POLICY grants_select ON "grants";
CREATE POLICY grants_select ON "grants" FOR SELECT TO trustvault_app
  USING (user_id = tv_current_user()
         OR group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = tv_current_user())
         OR tv_doc_level(document_id, tv_current_user()) >= 3);
