-- Fix for 20261102200000: the grant_group_members SELECT policy looked up
-- grants, whose own SELECT policy looks up grant_group_members, so Postgres
-- refused every query that touched either ("infinite recursion detected in
-- policy"). The manager check now goes through a SECURITY DEFINER helper
-- that reads grants without row-level security. Found by the local attack
-- run before anything was deployed.

CREATE FUNCTION tv_grant_manageable(p_grant uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT tv_doc_level(g.document_id, p_user) >= 3 FROM grants g WHERE g.id = p_grant), false)
$$;
REVOKE ALL ON FUNCTION tv_grant_manageable(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_grant_manageable(uuid, uuid) TO trustvault_app;

DROP POLICY ggm_select ON "grant_group_members";
CREATE POLICY ggm_select ON "grant_group_members" FOR SELECT TO trustvault_app
  USING (user_id = tv_current_user() OR tv_grant_manageable(grant_id, tv_current_user()));
