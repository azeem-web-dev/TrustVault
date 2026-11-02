-- Fix for 20261102200000, found by the test suite before deployment:
-- break_glass_now() moved created_at to the transaction start while the API
-- had computed expires_at from its own (slightly later) clock, so the
-- table's "expires_at <= created_at + 1 hour" check refused every
-- break-glass. The trigger now refuses anything clearly over an hour, then
-- caps expires_at at exactly one hour from created_at.

CREATE OR REPLACE FUNCTION break_glass_now() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  IF NEW.expires_at > now() + interval '61 minutes' THEN  -- one hour, plus a minute of clock difference
    RAISE EXCEPTION 'break-glass lasts at most one hour' USING ERRCODE = 'check_violation';
  END IF;
  NEW.expires_at := least(NEW.expires_at, NEW.created_at + interval '1 hour');
  RETURN NEW;
END
$$;
