-- Hole found by review on 2026-11-02: the app role may INSERT any row into
-- audit_checkpoints, and keyd signed any 'tv-checkpoint-v1|...' message.
-- With the API process compromised, an attacker could sign and store a
-- checkpoint for seq 2^62 with a made-up head hash. The checkpoint job only
-- signs when the chain head is above the latest checkpoint, so it would
-- never sign again and every later event would be unprotected.
--
-- Fix, in two independent halves:
--   - here: a checkpoint row is accepted only if it names a real audit event
--     (same seq, same hash) and moves strictly forward;
--   - keyd: refuses to sign a seq that is not above the last one it signed
--     (keyd/src/checkpoint.rs).
--
-- Only new inserts are checked; existing rows are untouched. The
-- UPDATE / DELETE / TRUNCATE guards from 20261101083248 stay as they are.

CREATE FUNCTION audit_checkpoints_guard_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  event_hash bytea;
  latest bigint;
BEGIN
  -- Serialise checkpoint inserts so two concurrent ones cannot both pass the
  -- "above the latest" test with the later one committing a lower seq.
  -- Every statement below takes a fresh snapshot (READ COMMITTED), so after
  -- the lock we see whatever the previous holder committed.
  PERFORM pg_advisory_xact_lock(hashtext('audit_checkpoints_guard_insert'));

  IF NEW."seq" IS NULL OR NEW."head_hash" IS NULL THEN
    RAISE EXCEPTION 'checkpoint needs a seq and a head hash' USING ERRCODE = 'check_violation';
  END IF;

  -- The checkpoint must describe the chain as it really is: the audit event
  -- at that seq exists and its hash is the head hash being signed.
  SELECT "hash" INTO event_hash FROM "audit_events" WHERE "seq" = NEW."seq";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'checkpoint refused: no audit event with seq %', NEW."seq"
      USING ERRCODE = 'check_violation';
  END IF;
  IF event_hash IS DISTINCT FROM NEW."head_hash" THEN
    RAISE EXCEPTION 'checkpoint refused: head hash does not match audit event %', NEW."seq"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Checkpoints only move forward; nothing can be slotted in behind the
  -- latest one.
  SELECT max("seq") INTO latest FROM "audit_checkpoints";
  IF latest IS NOT NULL AND NEW."seq" <= latest THEN
    RAISE EXCEPTION 'checkpoint refused: seq % is not above the latest checkpoint %', NEW."seq", latest
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION audit_checkpoints_guard_insert() FROM PUBLIC;

CREATE TRIGGER "audit_checkpoints_guard_insert" BEFORE INSERT ON "audit_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION audit_checkpoints_guard_insert();
