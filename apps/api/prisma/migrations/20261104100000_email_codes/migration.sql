-- Email codes as a second factor (THREATS.md S30).
--
-- A person may turn on "email me a code" as their second step. The codes
-- themselves never touch the database (Redis, HMAC only, 10 minutes); this
-- column only says the method is on. Rules, enforced here as well as in the
-- API, in the style of identity_guards (A23):
--
--   * never for an ADMIN: an administrator's mailbox must not be enough to
--     become that administrator (check constraint). Promoting someone who
--     uses it turns it off in the same statement, so they must enrol an
--     authenticator app or passkey;
--   * never for a published demo account (they get no mail);
--   * turned on only by the person themselves, as an active account;
--   * turned off by themselves, or by an administrator (an owner's only with
--     a second admin's approval used in the same transaction, as for TOTP).

ALTER TABLE "users" ADD COLUMN "email_otp_enabled_at" TIMESTAMPTZ(6);

ALTER TABLE "users" ADD CONSTRAINT users_email_otp_not_admin
  CHECK (email_otp_enabled_at IS NULL OR role <> 'ADMIN');
ALTER TABLE "users" ADD CONSTRAINT users_email_otp_not_demo
  CHECK (email_otp_enabled_at IS NULL OR NOT is_protected);

-- Readable by the app role (it is not a secret), like totp_enabled_at.
GRANT SELECT ("email_otp_enabled_at") ON "users" TO trustvault_app;

CREATE FUNCTION users_guard_email_otp() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  me uuid;
  promoted boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.email_otp_enabled_at IS NOT NULL AND NOT tv_is_schema_owner() THEN
      RAISE EXCEPTION 'a new account starts without email codes' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- Becoming an administrator: email codes stop counting, here and now.
  IF NEW.role = 'ADMIN' AND OLD.role <> 'ADMIN' AND NEW.email_otp_enabled_at IS NOT NULL
     AND NEW.email_otp_enabled_at IS NOT DISTINCT FROM OLD.email_otp_enabled_at THEN
    NEW.email_otp_enabled_at := NULL;
    promoted := true;
  END IF;

  IF tv_is_schema_owner() OR promoted OR NEW.email_otp_enabled_at IS NOT DISTINCT FROM OLD.email_otp_enabled_at THEN
    RETURN NEW;
  END IF;

  me := tv_current_user();                       -- a malformed value raises here
  IF me IS NOT NULL AND me = OLD.id AND OLD.status = 'ACTIVE' THEN
    RETURN NEW;                                  -- the person themselves
  END IF;
  IF NEW.email_otp_enabled_at IS NOT NULL OR NOT tv_is_active_admin(me) THEN
    RAISE EXCEPTION 'email codes are turned on only by their owner, and off only by them or an administrator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.role IN ('OWNER', 'ADMIN') AND NOT tv_mfa_reset_approved_now(OLD.id, me) THEN
    RAISE EXCEPTION 'clearing an owner''s or administrator''s second factor needs a second administrator''s approval, used now' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
-- Named to fire after users_guard_update (triggers run in name order).
CREATE TRIGGER users_guard_update_email_otp BEFORE INSERT OR UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_guard_email_otp();
REVOKE ALL ON FUNCTION users_guard_email_otp() FROM PUBLIC;
