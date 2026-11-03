-- The database protects identities on its own (THREATS.md A23-A26).
--
-- Until now the app's database role could UPDATE any column of any user,
-- add anyone to any group, and read every password hash and TOTP secret:
-- one bug or injected statement in any request could promote an account,
-- reactivate it, clear someone's second factor or copy the hashes. Now, for
-- the app role (the schema owner, migrations and SECURITY DEFINER functions
-- are exempt, as in documents_guard_update):
--
--   users          role, status, end date and deactivation only in an active
--                  ADMIN's transaction (app.user_id), never on their own row,
--                  never removing the last active admin; email, id, creation
--                  and is_protected never; a password only as yourself or
--                  with a reset or invitation link used in the same
--                  transaction; a second factor set only by yourself, cleared
--                  by yourself or by an admin (an owner's or admin's only
--                  with a second admin's approval used in the same
--                  transaction, S19); sign-in counters and the TOTP replay
--                  marker (forwards only) from any context, alone; new rows
--                  only by an admin and only as an invitation.
--   passkeys       added only by their owner; removed by their owner or an
--                  admin (as above); the counter only moves forward.
--   groups,        written only in an active admin's transaction.
--   group_members
--   reset links    once used, stay used; only the hash, user, purpose and
--                  expiry given at creation; used_at is the database's clock.
--   hashes and     not readable by the app role at all; the two code paths
--   TOTP secrets   that need one call a narrow function.
--
-- app.user_id unset means nobody; malformed fails the statement (closed).
-- app.user_id is set by the API, as for row-level security: these rules stop
-- a bug or an injected statement in someone's request, not a fully
-- compromised API process, which can claim any app.user_id (THREATS.md I6).

-- ---------- Helpers ----------
-- (Executable by everyone: it only says whether the caller is the schema owner.)
CREATE FUNCTION tv_is_schema_owner() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'), 'MEMBER')
$$;

-- A link of this purpose for this person was used in this transaction.
CREATE FUNCTION tv_link_used_now(p_user uuid, p_purpose "LinkPurpose") RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM password_reset_tokens t WHERE t.user_id = p_user AND t.purpose = p_purpose AND t.used_at = now() AND t.expires_at > now())
$$;

-- A second admin's approval to clear this person's second factor, used in
-- this transaction by the admin asking (THREATS.md S19).
CREATE FUNCTION tv_mfa_reset_approved_now(p_user uuid, p_admin uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM admin_approvals a WHERE a.action = 'MFA_RESET' AND a.target_user_id = p_user
                   AND a.requested_by = p_admin AND a.approved_by IS NOT NULL AND a.consumed_at = now())
$$;
REVOKE ALL ON FUNCTION tv_link_used_now(uuid, "LinkPurpose"), tv_mfa_reset_approved_now(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_link_used_now(uuid, "LinkPurpose"), tv_mfa_reset_approved_now(uuid, uuid) TO trustvault_app;

-- ---------- users: who may change what ----------
CREATE FUNCTION users_guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  me uuid;
  admin_ boolean;
  self_ boolean;
  accepting boolean;
  resetting boolean;
BEGIN
  IF tv_is_schema_owner() THEN RETURN NEW; END IF;
  me := tv_current_user();                       -- a malformed value raises here
  admin_ := tv_is_active_admin(me);
  self_ := me IS NOT NULL AND me = OLD.id AND OLD.status = 'ACTIVE';
  -- Accepting an invitation: INVITED becomes ACTIVE with the link used now.
  accepting := OLD.status = 'INVITED' AND NEW.status = 'ACTIVE' AND tv_link_used_now(OLD.id, 'INVITE');
  resetting := OLD.status = 'ACTIVE' AND tv_link_used_now(OLD.id, 'RESET');

  IF (NEW.id, NEW.email, NEW.created_at, NEW.created_by_id, NEW.is_protected)
     IS DISTINCT FROM (OLD.id, OLD.email, OLD.created_at, OLD.created_by_id, OLD.is_protected) THEN
    RAISE EXCEPTION 'identity columns cannot be changed by the app' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Published demo accounts: only sign-in counters and the replay marker move (I8).
  IF OLD.is_protected AND (NEW.role, NEW.status, NEW.display_name, NEW.access_expires_at, NEW.deactivated_at, NEW.activated_at,
                           NEW.password_hash, NEW.password_changed_at, NEW.totp_secret_enc, NEW.totp_enabled_at)
     IS DISTINCT FROM (OLD.role, OLD.status, OLD.display_name, OLD.access_expires_at, OLD.deactivated_at, OLD.activated_at,
                       OLD.password_hash, OLD.password_changed_at, OLD.totp_secret_enc, OLD.totp_enabled_at) THEN
    RAISE EXCEPTION 'protected demo accounts cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Role, status, end date: an admin, on someone else (or the invitation being accepted).
  IF (NEW.role, NEW.status, NEW.access_expires_at, NEW.deactivated_at) IS DISTINCT FROM (OLD.role, OLD.status, OLD.access_expires_at, OLD.deactivated_at) THEN
    IF me IS NOT NULL AND me = OLD.id THEN
      RAISE EXCEPTION 'nobody changes their own role, status or end date' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT admin_ AND NOT (accepting AND (NEW.role, NEW.access_expires_at, NEW.deactivated_at) IS NOT DISTINCT FROM (OLD.role, OLD.access_expires_at, OLD.deactivated_at)) THEN
      RAISE EXCEPTION 'only an administrator changes role, status or end date' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.activated_at IS DISTINCT FROM OLD.activated_at AND NOT (accepting AND OLD.activated_at IS NULL) THEN
    RAISE EXCEPTION 'an account is activated only by accepting its invitation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.display_name IS DISTINCT FROM OLD.display_name AND NOT (admin_ OR accepting) THEN
    RAISE EXCEPTION 'only an administrator renames an account' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A password: as yourself, or with a link used in this transaction.
  IF (NEW.password_hash, NEW.password_changed_at) IS DISTINCT FROM (OLD.password_hash, OLD.password_changed_at)
     AND NOT (self_ OR accepting OR resetting) THEN
    RAISE EXCEPTION 'a password is set only by its owner or with a reset or invitation link' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A second factor: set by yourself; cleared by yourself or by an admin.
  IF (NEW.totp_secret_enc, NEW.totp_enabled_at) IS DISTINCT FROM (OLD.totp_secret_enc, OLD.totp_enabled_at) THEN
    IF NOT self_ THEN
      IF NOT admin_ OR NEW.totp_secret_enc IS NOT NULL OR NEW.totp_enabled_at IS NOT NULL THEN
        RAISE EXCEPTION 'a second factor is set only by its owner, and cleared only by them or an administrator' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF OLD.role IN ('OWNER', 'ADMIN') AND NOT tv_mfa_reset_approved_now(OLD.id, me) THEN
        RAISE EXCEPTION 'clearing an owner''s or administrator''s second factor needs a second administrator''s approval, used now' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;
  -- The replay marker moves forward from anywhere; back to empty only with the factor itself.
  IF NEW.totp_last_step IS DISTINCT FROM OLD.totp_last_step
     AND NOT (NEW.totp_last_step IS NOT NULL AND (OLD.totp_last_step IS NULL OR NEW.totp_last_step > OLD.totp_last_step))
     AND NOT (NEW.totp_last_step IS NULL AND (self_ OR admin_)) THEN
    RAISE EXCEPTION 'the TOTP replay marker only moves forward' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- failed_login_count and locked_until: sign-in moves them without a user, alone.

  -- Never remove the last active administrator. One lock for everyone doing
  -- it, so two admins demoting each other cannot both succeed.
  IF OLD.role = 'ADMIN' AND OLD.status = 'ACTIVE' AND NOT (NEW.role = 'ADMIN' AND NEW.status = 'ACTIVE') THEN
    PERFORM pg_advisory_xact_lock(7310200);
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.role = 'ADMIN' AND u.status = 'ACTIVE' AND u.id <> OLD.id) THEN
      RAISE EXCEPTION 'at least one active administrator must remain' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_guard_update BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_guard_update();

-- New accounts: only by an admin, only as an invitation (THREATS.md S18).
CREATE FUNCTION users_guard_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF tv_is_schema_owner() THEN RETURN NEW; END IF;
  IF NOT tv_is_active_admin(tv_current_user()) OR NEW.created_by_id IS DISTINCT FROM tv_current_user()
     OR NEW.status <> 'INVITED' OR NEW.activated_at IS NOT NULL OR NEW.is_protected
     OR NEW.totp_secret_enc IS NOT NULL OR NEW.totp_enabled_at IS NOT NULL OR NEW.failed_login_count <> 0 OR NEW.locked_until IS NOT NULL THEN
    RAISE EXCEPTION 'accounts are created only by an administrator, as an invitation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_guard_insert BEFORE INSERT ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_guard_insert();

-- ---------- passkeys ----------
CREATE FUNCTION passkeys_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  me uuid;
  target_role "Role";
BEGIN
  IF tv_is_schema_owner() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  me := tv_current_user();
  IF TG_OP = 'INSERT' THEN
    IF me IS NULL OR me <> NEW.user_id OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = me AND u.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'a passkey is added only by its owner' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Signing in moves the counter forward and stamps last use; the owner may rename.
    IF (NEW.id, NEW.user_id, NEW.credential_id, NEW.public_key, NEW.transports, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.credential_id, OLD.public_key, OLD.transports, OLD.created_at)
       OR NEW.counter < OLD.counter
       OR (NEW.name IS DISTINCT FROM OLD.name AND me IS DISTINCT FROM OLD.user_id) THEN
      RAISE EXCEPTION 'a passkey cannot be changed that way' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- DELETE: the owner, or an admin (an owner's or admin's key only with an approval used now).
  IF me IS NOT NULL AND me = OLD.user_id THEN RETURN OLD; END IF;
  IF tv_is_active_admin(me) THEN
    SELECT role INTO target_role FROM users WHERE id = OLD.user_id;
    IF target_role NOT IN ('OWNER', 'ADMIN') OR tv_mfa_reset_approved_now(OLD.user_id, me) THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'a passkey is removed only by its owner or, with the rules for second factors, an administrator' USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER passkeys_guard BEFORE INSERT OR UPDATE OR DELETE ON "passkeys"
  FOR EACH ROW EXECUTE FUNCTION passkeys_guard();

-- ---------- groups and memberships: administrators only ----------
CREATE FUNCTION groups_admin_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT tv_is_schema_owner() AND NOT tv_is_active_admin(tv_current_user()) THEN
    RAISE EXCEPTION 'groups and their members are changed only by an administrator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER groups_admin_only BEFORE INSERT OR UPDATE OR DELETE ON "groups"
  FOR EACH ROW EXECUTE FUNCTION groups_admin_only();
-- Fires after group_members_0_lock (the person's lock comes first).
CREATE TRIGGER group_members_admin_only BEFORE INSERT OR UPDATE OR DELETE ON "group_members"
  FOR EACH ROW EXECUTE FUNCTION groups_admin_only();

-- ---------- reset and invitation links ----------
CREATE FUNCTION password_reset_tokens_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF tv_is_schema_owner() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.used_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new link starts unused' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.user_id, NEW.token_hash, NEW.expires_at, NEW.requested_by, NEW.purpose, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.token_hash, OLD.expires_at, OLD.requested_by, OLD.purpose, OLD.created_at)
     OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
     OR NEW.used_at IS NULL AND OLD.used_at IS NULL THEN
    RAISE EXCEPTION 'a link can only be marked used, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.used_at := now();   -- the database's clock, which the users guard matches
  RETURN NEW;
END
$$;
CREATE TRIGGER password_reset_tokens_guard BEFORE INSERT OR UPDATE ON "password_reset_tokens"
  FOR EACH ROW EXECUTE FUNCTION password_reset_tokens_guard();

REVOKE ALL ON FUNCTION users_guard_update(), users_guard_insert(), passkeys_guard(), groups_admin_only(), password_reset_tokens_guard() FROM PUBLIC;

-- ---------- Hashes and secrets are not readable by the app role ----------
-- Column privileges: everything but password_hash and totp_secret_enc.
-- (Writing them is still allowed, under the rules above.)
REVOKE SELECT ON "users" FROM trustvault_app;
GRANT SELECT ("id", "email", "display_name", "role", "status", "password_changed_at", "failed_login_count", "locked_until",
              "access_expires_at", "created_at", "updated_at", "created_by_id", "deactivated_at", "activated_at",
              "is_protected", "totp_enabled_at", "totp_last_step") ON "users" TO trustvault_app;

-- The two code paths that need one: checking a password at sign-in or
-- change, and checking a TOTP code (the secret is sealed by the key service).
CREATE FUNCTION tv_password_hash(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT password_hash FROM users WHERE id = p_user
$$;
CREATE FUNCTION tv_totp_secret(p_user uuid) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT totp_secret_enc FROM users WHERE id = p_user
$$;
REVOKE ALL ON FUNCTION tv_password_hash(uuid), tv_totp_secret(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_password_hash(uuid), tv_totp_secret(uuid) TO trustvault_app;
