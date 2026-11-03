-- Instance settings are changed only in an active administrator's
-- transaction (THREATS.md S20), like groups (A25). The API already checks
-- the role and a fresh second factor; this is the database's own backstop,
-- so a bug or injected statement in another request cannot weaken the
-- second-factor policy. The schema owner (migrations, tests) is exempt.
CREATE FUNCTION tv_admin_only_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT tv_is_schema_owner() AND NOT tv_is_active_admin(tv_current_user()) THEN
    RAISE EXCEPTION '% is changed only by an administrator', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION tv_admin_only_write() FROM PUBLIC;
CREATE TRIGGER app_settings_admin_only BEFORE INSERT OR UPDATE OR DELETE ON "app_settings"
  FOR EACH ROW EXECUTE FUNCTION tv_admin_only_write();
