-- keyd authorises decryption itself (THREATS.md K1-K4, docs/KEYS.md).
--
-- Before: keyd unwrapped any data key the API asked for, so a compromised
-- API could decrypt every stored file. Now keyd only unwraps a document data
-- key against a TICKET minted here, by a function that runs as the schema
-- owner and MACs the ticket with a secret the application role cannot read.
-- The function checks, below the application:
--   - the caller's access level (tv_doc_level) for the action,
--   - that a fresh ALLOWED audit event exists for exactly that user,
--     document, version and action, and has not backed a ticket before,
--   - that the version is not quarantined (for user downloads).
-- The nightly rescan (no user) gets tickets too; keyd caps those per hour
-- (KEYD_LIMIT_SYSTEM_PER_HOUR, 0 disables rescan decryption).
-- keyd checks the MAC, the 30 s expiry, single use, rate limits, and that
-- the wrapped key and AAD it is asked to open are the ones in the ticket,
-- and writes every unwrap to its own signed ledger (keyd/src/ledger.rs).

-- ---------- Ticket MAC keys: schema owner only ----------
-- The same 32 bytes are installed for keyd as /etc/tvkeyd/ticket.key
-- (infra/server/ticket-key.sh). trustvault_app gets no privilege at all.
CREATE TABLE "keyd_ticket_keys" (
    "kid"        TEXT NOT NULL,
    "secret"     BYTEA NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "keyd_ticket_keys_pkey" PRIMARY KEY ("kid"),
    CONSTRAINT "keyd_ticket_keys_kid" CHECK ("kid" ~ '^[0-9a-f]{16}$'),
    CONSTRAINT "keyd_ticket_keys_len" CHECK (octet_length("secret") = 32)
);
REVOKE ALL ON "keyd_ticket_keys" FROM PUBLIC;

-- HMAC-SHA256 (RFC 2104) with the built-in sha256(); no extension needed.
CREATE FUNCTION tv_hmac_sha256(p_key bytea, p_msg bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE
  k bytea := p_key;
  ipad bytea;
  opad bytea;
BEGIN
  IF octet_length(k) > 64 THEN k := sha256(k); END IF;
  k := k || decode(repeat('00', 64 - octet_length(k)), 'hex');
  ipad := k;
  opad := k;
  FOR i IN 0..63 LOOP
    ipad := set_byte(ipad, i, get_byte(k, i) # 54);   -- 0x36
    opad := set_byte(opad, i, get_byte(k, i) # 92);   -- 0x5c
  END LOOP;
  RETURN sha256(opad || sha256(ipad || p_msg));
END
$$;

CREATE FUNCTION tv_ticket_kid(p_secret bytea) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT substr(encode(sha256(convert_to('tv-ticket-kid-v1|', 'UTF8') || p_secret), 'hex'), 1, 16)
$$;

-- Installs (or re-activates) the ticket key; every other key is
-- deactivated. Owner only: run by infra/server/ticket-key.sh.
CREATE FUNCTION tv_install_ticket_key(p_secret bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_kid text;
BEGIN
  IF p_secret IS NULL OR octet_length(p_secret) <> 32 THEN
    RAISE EXCEPTION 'ticket key must be 32 bytes';
  END IF;
  v_kid := tv_ticket_kid(p_secret);
  INSERT INTO keyd_ticket_keys (kid, secret) VALUES (v_kid, p_secret)
    ON CONFLICT (kid) DO UPDATE SET active = true;
  UPDATE keyd_ticket_keys SET active = false WHERE kid <> v_kid AND active;
  RETURN v_kid;
END
$$;

-- ---------- What each ticketed action needs ----------
-- Levels as in 20261103200100_view_only: 1 VIEW, 2 READ, 3 EDIT, 4 MANAGE,
-- 5 owner. A download needs READ; a view-only page render needs VIEW and is
-- backed by its own 'document.render' audit row (one per drawn version, so
-- paging through a document is one unwrap, not one per page); the Android
-- app's copy key needs READ and opens the offline_keys row, not a blob.
CREATE TABLE "unwrap_actions" (
    "action"             TEXT NOT NULL,
    "audit_action"       TEXT NOT NULL,
    "min_level"          INTEGER NOT NULL,
    "system"             BOOLEAN NOT NULL,
    "refuse_quarantined" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "unwrap_actions_pkey" PRIMARY KEY ("action"),
    CONSTRAINT "unwrap_actions_name" CHECK ("action" ~ '^[a-z_]{1,32}$'),
    CONSTRAINT "unwrap_actions_level" CHECK ("min_level" BETWEEN 0 AND 5),
    -- System actions (no user) are exactly those with no level requirement.
    CONSTRAINT "unwrap_actions_system" CHECK ("system" = ("min_level" = 0))
);
INSERT INTO "unwrap_actions" ("action", "audit_action", "min_level", "system", "refuse_quarantined") VALUES
  ('download',    'document.download',       2, false, true),
  ('view_page',   'document.render',         1, false, true),
  ('offline_key', 'document.offline_key',    2, false, true),
  ('rescan',      'document.rescan_decrypt', 0, true,  false);
REVOKE ALL ON "unwrap_actions" FROM PUBLIC;
GRANT SELECT ON "unwrap_actions" TO trustvault_app;

-- ---------- Every ticket issued ----------
-- Readable by the app (reconciliation), written only by the functions below.
-- No foreign keys: the record outlives a purged document.
CREATE TABLE "unwrap_tickets" (
    "id"             UUID NOT NULL,
    "audit_event_id" UUID NOT NULL,
    "audit_seq"      BIGINT NOT NULL,
    "action"         TEXT NOT NULL,
    "document_id"    UUID NOT NULL,
    "version_id"     UUID NOT NULL,
    "user_id"        UUID,
    "issued_at"      TIMESTAMPTZ(6) NOT NULL,
    "expires_at"     TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "unwrap_tickets_pkey" PRIMARY KEY ("id"),
    -- One audit event backs at most one ticket.
    CONSTRAINT "unwrap_tickets_audit_event_key" UNIQUE ("audit_event_id")
);
CREATE INDEX "unwrap_tickets_version_idx" ON "unwrap_tickets" ("version_id", "action", "issued_at");
CREATE INDEX "unwrap_tickets_issued_idx" ON "unwrap_tickets" ("issued_at");
REVOKE ALL ON "unwrap_tickets" FROM PUBLIC;
GRANT SELECT ON "unwrap_tickets" TO trustvault_app;

CREATE FUNCTION tv_block_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER "unwrap_tickets_append_only" BEFORE UPDATE OR DELETE ON "unwrap_tickets"
  FOR EACH ROW EXECUTE FUNCTION tv_block_change();
CREATE TRIGGER "unwrap_tickets_no_truncate" BEFORE TRUNCATE ON "unwrap_tickets"
  FOR EACH STATEMENT EXECUTE FUNCTION tv_block_change();

-- ---------- Minting (internal) ----------
-- Records the ticket and returns its text. Called only by the two issuing
-- functions below; nobody else may execute it.
CREATE FUNCTION tv_mint_unwrap_ticket(p_action text, p_version uuid, p_user uuid, p_audit_event uuid, p_audit_seq bigint)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v record;
  k record;
  t timestamptz := clock_timestamp();
  v_iat bigint;
  v_exp bigint;
  v_tid uuid := gen_random_uuid();
  v_aad text;
  v_body text;
BEGIN
  SELECT dv.id, dv.document_id, dv.version_no, b.wrapped_key INTO v
    FROM document_versions dv JOIN document_blobs b ON b.version_id = dv.id
   WHERE dv.id = p_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unwrap ticket refused: no such version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The Android copy key: the ticket names the person's offline_keys row
  -- (its wrapped key and AAD) instead of the version's data key.
  IF p_action = 'offline_key' THEN
    SELECT o.wrapped_key INTO v.wrapped_key FROM offline_keys o WHERE o.document_id = v.document_id AND o.user_id = p_user;
    IF NOT FOUND OR p_user IS NULL THEN
      RAISE EXCEPTION 'unwrap ticket refused: no copy key' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  SELECT kid, secret INTO k FROM keyd_ticket_keys WHERE active ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unwrap ticket refused: no ticket key installed (infra/server/ticket-key.sh)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_iat := floor(extract(epoch FROM t))::bigint;
  v_exp := v_iat + 30;
  INSERT INTO unwrap_tickets (id, audit_event_id, audit_seq, action, document_id, version_id, user_id, issued_at, expires_at)
  VALUES (v_tid, p_audit_event, p_audit_seq, p_action, v.document_id, v.id, p_user, t, to_timestamp(v_exp));
  v_aad := CASE WHEN p_action = 'offline_key' THEN 'tv-offline-v1|' || v.document_id::text || '|' || p_user::text
                ELSE 'tv-blob-v1|' || v.document_id::text || '|' || v.id::text || '|' || v.version_no::text END;
  v_body := 'tv-unwrap-ticket-v1|' || k.kid || '|' || v_tid::text || '|' || p_action || '|' || v.document_id::text
         || '|' || v.id::text || '|' || coalesce(p_user::text, '-')
         || '|' || encode(sha256(convert_to(v_aad, 'UTF8')), 'hex')
         || '|' || encode(sha256(v.wrapped_key), 'hex')
         || '|' || p_audit_event::text || '|' || p_audit_seq::text || '|' || v_iat::text || '|' || v_exp::text;
  RETURN v_body || '|' || encode(tv_hmac_sha256(k.secret, convert_to(v_body, 'UTF8')), 'hex');
END
$$;

-- ---------- The application's way in ----------
-- Call inside the transaction that wrote the ALLOWED audit event, after
-- writing it: SELECT tv_issue_unwrap_ticket(<version>, '<action>', <audit event id>).
-- The user is the transaction's app.user_id (none for system actions).
-- Every refusal raises insufficient_privilege and rolls the transaction back.
CREATE FUNCTION tv_issue_unwrap_ticket(p_version uuid, p_action text, p_audit_event uuid) RETURNS text
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
  ELSIF u IS NULL OR tv_doc_level(v.document_id, u) < a.min_level THEN
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

-- ---------- Emergency re-encryption (owner only) ----------
-- tools: `node dist/cli/keys.js reencrypt` with the owner database URL.
-- The application role cannot execute this. keyd additionally refuses
-- 'reencrypt' tickets unless the operator raised KEYD_LIMIT_MAINT_PER_HOUR.
CREATE FUNCTION tv_issue_maintenance_ticket(p_version uuid, p_audit_event uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  e record;
  v record;
BEGIN
  SELECT dv.document_id, dv.version_no INTO v FROM document_versions dv WHERE dv.id = p_version;
  SELECT ae.id, ae.seq, ae.action, ae.outcome, ae.document_id, ae.actor_id, ae.occurred_at, ae.details INTO e
    FROM audit_events ae WHERE ae.id = p_audit_event;
  IF v IS NULL OR e IS NULL OR e.action <> 'keys.reencrypt_version' OR e.outcome <> 'ALLOWED'
     OR e.document_id IS DISTINCT FROM v.document_id OR e.actor_id IS NOT NULL
     OR e.occurred_at < clock_timestamp() - interval '60 seconds'
     OR (e.details ->> 'versionNo') IS DISTINCT FROM v.version_no::text THEN
    RAISE EXCEPTION 'unwrap ticket refused: no matching audit event' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN tv_mint_unwrap_ticket('reencrypt', p_version, NULL, e.id, e.seq);
END
$$;

REVOKE ALL ON FUNCTION tv_hmac_sha256(bytea, bytea), tv_ticket_kid(bytea), tv_install_ticket_key(bytea),
  tv_mint_unwrap_ticket(text, uuid, uuid, uuid, bigint), tv_issue_unwrap_ticket(uuid, text, uuid),
  tv_issue_maintenance_ticket(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_issue_unwrap_ticket(uuid, text, uuid) TO trustvault_app;

-- ---------- Mirror of keyd's ledger, for reconciliation ----------
-- The API copies keyd's ledger here after checking every hash link and the
-- signed head (KeyLedgerService). Insert-only; the trigger also refuses a
-- row that does not extend its chain, so a gap cannot be papered over by
-- inserting rows out of order. Each keyd ledger file is one chain, its
-- "epoch" being the hash of its first entry; a new epoch is reported
-- (keyd's state was replaced or lost). `n` orders rows across epochs.
CREATE TABLE "keyd_ledger_entries" (
    "n"              BIGINT GENERATED ALWAYS AS IDENTITY,
    "epoch"          TEXT NOT NULL,
    "seq"            BIGINT NOT NULL,
    "ts_ms"          BIGINT NOT NULL,
    "event"          TEXT NOT NULL,
    "action"         TEXT,
    "tid"            TEXT,
    "user_id"        TEXT,
    "document_id"    TEXT,
    "version_id"     TEXT,
    "audit_event_id" TEXT,
    "audit_seq"      BIGINT,
    "key_id"         TEXT,
    "aad_sha256"     TEXT,
    "result"         TEXT NOT NULL,
    "detail"         TEXT,
    "prev_hash"      TEXT NOT NULL,
    "hash"           TEXT NOT NULL,
    "mirrored_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "keyd_ledger_entries_pkey" PRIMARY KEY ("n"),
    CONSTRAINT "keyd_ledger_entries_epoch_seq_key" UNIQUE ("epoch", "seq"),
    CONSTRAINT "keyd_ledger_entries_hex" CHECK ("hash" ~ '^[0-9a-f]{64}$' AND "prev_hash" ~ '^[0-9a-f]{64}$' AND "epoch" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "keyd_ledger_entries_audit_idx" ON "keyd_ledger_entries" ("audit_event_id");
CREATE INDEX "keyd_ledger_entries_tid_idx" ON "keyd_ledger_entries" ("tid");

CREATE FUNCTION keyd_ledger_entries_extend() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  last record;
BEGIN
  PERFORM pg_advisory_xact_lock(7310002);
  SELECT seq, hash INTO last FROM keyd_ledger_entries WHERE epoch = NEW.epoch ORDER BY seq DESC LIMIT 1;
  IF last.seq IS NULL THEN
    IF NEW.seq <> 1 OR NEW.prev_hash <> repeat('0', 64) OR NEW.hash <> NEW.epoch THEN
      RAISE EXCEPTION 'keyd ledger mirror: a chain must start at its genesis entry';
    END IF;
  ELSIF NEW.seq <> last.seq + 1 OR NEW.prev_hash <> last.hash THEN
    RAISE EXCEPTION 'keyd ledger entry % does not extend the mirrored chain (head %)', NEW.seq, last.seq;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "keyd_ledger_entries_extend" BEFORE INSERT ON "keyd_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION keyd_ledger_entries_extend();
CREATE TRIGGER "keyd_ledger_entries_append_only" BEFORE UPDATE OR DELETE ON "keyd_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION tv_block_change();
CREATE TRIGGER "keyd_ledger_entries_no_truncate" BEFORE TRUNCATE ON "keyd_ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION tv_block_change();

-- Signed ledger heads (published by trustvault-anchor like audit checkpoints).
CREATE TABLE "keyd_ledger_checkpoints" (
    "n"          BIGINT GENERATED ALWAYS AS IDENTITY,
    "epoch"      TEXT NOT NULL,
    "seq"        BIGINT NOT NULL,
    "head_hash"  TEXT NOT NULL,
    "signature"  TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "key_id"     TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "keyd_ledger_checkpoints_pkey" PRIMARY KEY ("n"),
    CONSTRAINT "keyd_ledger_checkpoints_epoch_seq_key" UNIQUE ("epoch", "seq")
);
CREATE TRIGGER "keyd_ledger_checkpoints_append_only" BEFORE UPDATE OR DELETE ON "keyd_ledger_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION tv_block_change();
CREATE TRIGGER "keyd_ledger_checkpoints_no_truncate" BEFORE TRUNCATE ON "keyd_ledger_checkpoints"
  FOR EACH STATEMENT EXECUTE FUNCTION tv_block_change();

REVOKE ALL ON "keyd_ledger_entries", "keyd_ledger_checkpoints" FROM PUBLIC;
GRANT SELECT, INSERT ON "keyd_ledger_entries", "keyd_ledger_checkpoints" TO trustvault_app;
REVOKE ALL ON FUNCTION keyd_ledger_entries_extend() FROM PUBLIC;

-- ---------- Which keys protect what (counts only) ----------
-- For /admin/keyd/status and the rotation tool: how many document data keys
-- and TOTP secrets are wrapped under each key id. No content, no ids.
CREATE FUNCTION tv_key_usage() RETURNS TABLE (key_id text, n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT 'blob:' || b.key_id, count(*) FROM document_blobs b GROUP BY b.key_id
  UNION ALL
  SELECT 'totp:' || convert_from(substring(u.totp_secret_enc FROM 2 FOR get_byte(u.totp_secret_enc, 0)), 'UTF8'), count(*)
    FROM users u WHERE u.totp_secret_enc IS NOT NULL AND octet_length(u.totp_secret_enc) > 1
   GROUP BY 1
$$;
REVOKE ALL ON FUNCTION tv_key_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tv_key_usage() TO trustvault_app;
