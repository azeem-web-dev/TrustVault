-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('ACTIVE', 'DELETED');

-- CreateEnum
CREATE TYPE "GrantLevel" AS ENUM ('READ', 'EDIT', 'MANAGE');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_protected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totp_enabled_at" TIMESTAMPTZ(6),
ADD COLUMN     "totp_last_step" BIGINT,
ADD COLUMN     "totp_secret_enc" BYTEA;

-- CreateTable
CREATE TABLE "folders" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "folder_id" UUID,
    "status" "DocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "deleted_at" TIMESTAMPTZ(6),
    "current_version_no" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" BYTEA NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_blobs" (
    "version_id" UUID NOT NULL,
    "wrapped_key" BYTEA NOT NULL,
    "key_id" TEXT NOT NULL,
    "nonce" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,

    CONSTRAINT "document_blobs_pkey" PRIMARY KEY ("version_id")
);

-- CreateTable
CREATE TABLE "grants" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "user_id" UUID,
    "group_id" UUID,
    "level" "GrantLevel" NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "granted_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "break_glass" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "break_glass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_checkpoints" (
    "seq" BIGINT NOT NULL,
    "head_hash" BYTEA NOT NULL,
    "signature" BYTEA NOT NULL,
    "key_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_checkpoints_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "passkeys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "folders_owner_id_name_key" ON "folders"("owner_id", "name");

-- CreateIndex
CREATE INDEX "documents_owner_id_idx" ON "documents"("owner_id");

-- CreateIndex
CREATE INDEX "documents_category_idx" ON "documents"("category");

-- CreateIndex
CREATE INDEX "documents_created_at_idx" ON "documents"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_no_key" ON "document_versions"("document_id", "version_no");

-- CreateIndex
CREATE INDEX "grants_user_id_idx" ON "grants"("user_id");

-- CreateIndex
CREATE INDEX "grants_group_id_idx" ON "grants"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "grants_document_id_user_id_key" ON "grants"("document_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "grants_document_id_group_id_key" ON "grants"("document_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "groups_name_key" ON "groups"("name");

-- CreateIndex
CREATE INDEX "group_members_user_id_idx" ON "group_members"("user_id");

-- CreateIndex
CREATE INDEX "break_glass_document_id_admin_id_idx" ON "break_glass"("document_id", "admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "passkeys_credential_id_key" ON "passkeys"("credential_id");

-- CreateIndex
CREATE INDEX "passkeys_user_id_idx" ON "passkeys"("user_id");

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_blobs" ADD CONSTRAINT "document_blobs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_glass" ADD CONSTRAINT "break_glass_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_glass" ADD CONSTRAINT "break_glass_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- Hand-written below this line: integrity rules, privileges, and
-- row-level security (the second, independent lock on every document).
-- =====================================================================

-- ---------- Integrity ----------
ALTER TABLE "documents" ADD CONSTRAINT "documents_title_len" CHECK (char_length("title") BETWEEN 1 AND 200);
ALTER TABLE "documents" ADD CONSTRAINT "documents_category_len" CHECK (char_length("category") BETWEEN 1 AND 60);
ALTER TABLE "documents" ADD CONSTRAINT "documents_description_len" CHECK ("description" IS NULL OR char_length("description") <= 2000);
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_has_time" CHECK (("status" = 'DELETED') = ("deleted_at" IS NOT NULL));
ALTER TABLE "folders" ADD CONSTRAINT "folders_name_len" CHECK (char_length("name") BETWEEN 1 AND 100);
ALTER TABLE "document_versions" ADD CONSTRAINT "versions_size_positive" CHECK ("size_bytes" > 0);
ALTER TABLE "document_versions" ADD CONSTRAINT "versions_sha256_len" CHECK (octet_length("sha256") = 32);
ALTER TABLE "document_blobs" ADD CONSTRAINT "blobs_nonce_len" CHECK (octet_length("nonce") = 12);
ALTER TABLE "document_blobs" ADD CONSTRAINT "blobs_tag_len" CHECK (octet_length("auth_tag") = 16);
ALTER TABLE "grants" ADD CONSTRAINT "grants_user_xor_group" CHECK (("user_id" IS NULL) <> ("group_id" IS NULL));
ALTER TABLE "break_glass" ADD CONSTRAINT "break_glass_reason_len" CHECK (char_length("reason") >= 20);
ALTER TABLE "break_glass" ADD CONSTRAINT "break_glass_expiry" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '1 hour');

-- ---------- Who is asking ----------
-- The API sets app.user_id at the start of every transaction that touches
-- documents (set_config with is_local = true: this transaction only).
-- Unset means nobody, and nobody can see anything.
CREATE FUNCTION tv_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------- Effective access level, computed in SQL ----------
-- 0 none, 1 READ, 2 EDIT, 3 MANAGE, 4 owner. Written independently of the
-- TypeScript decide() on purpose: two implementations, two locks.
-- SECURITY DEFINER so it can read grants and group_members regardless of
-- their own policies (avoids policy recursion). It only returns a number.
CREATE FUNCTION tv_doc_level(p_doc uuid, p_user uuid) RETURNS int
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  u_role "Role";
  d_owner uuid;
  d_status "DocumentStatus";
  lvl int := 0;
BEGIN
  IF p_doc IS NULL OR p_user IS NULL THEN RETURN 0; END IF;

  SELECT role INTO u_role FROM users
   WHERE id = p_user AND status = 'ACTIVE' AND (access_expires_at IS NULL OR access_expires_at > now());
  IF NOT FOUND THEN RETURN 0; END IF;            -- deactivated, expired or unknown

  SELECT owner_id, status INTO d_owner, d_status FROM documents WHERE id = p_doc;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF d_owner = p_user THEN RETURN 4; END IF;     -- owners keep access to their own trash
  IF d_status <> 'ACTIVE' THEN RETURN 0; END IF; -- nobody else sees deleted documents

  SELECT coalesce(max(CASE g.level WHEN 'MANAGE' THEN 3 WHEN 'EDIT' THEN 2 ELSE 1 END), 0) INTO lvl
    FROM grants g
   WHERE g.document_id = p_doc
     AND (g.expires_at IS NULL OR g.expires_at > now())
     AND (g.user_id = p_user
          OR (u_role <> 'EXTERNAL' AND g.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = p_user)));

  IF lvl = 0 AND u_role = 'ADMIN' AND EXISTS (
       SELECT 1 FROM break_glass b WHERE b.document_id = p_doc AND b.admin_id = p_user AND b.expires_at > now()) THEN
    lvl := 1;
  END IF;

  IF u_role = 'EXTERNAL' THEN lvl := least(lvl, 1); END IF;  -- externals: read at most
  RETURN lvl;
END
$$;

-- ---------- Privileges for the running app ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON "folders", "documents", "grants", "groups", "group_members", "passkeys" TO trustvault_app;
-- File versions and their bytes are immutable once written.
GRANT SELECT, INSERT ON "document_versions", "document_blobs" TO trustvault_app;
GRANT SELECT, INSERT ON "break_glass" TO trustvault_app;
GRANT SELECT, INSERT ON "audit_checkpoints" TO trustvault_app;
GRANT EXECUTE ON FUNCTION tv_current_user() TO trustvault_app;
GRANT EXECUTE ON FUNCTION tv_doc_level(uuid, uuid) TO trustvault_app;

-- ---------- Row-level security ----------
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_blobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "folders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "break_glass" ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_select ON "documents" FOR SELECT TO trustvault_app
  USING (tv_doc_level(id, tv_current_user()) >= 1);
-- Only active OWNER-role accounts create documents, and only as themselves.
CREATE POLICY documents_insert ON "documents" FOR INSERT TO trustvault_app
  WITH CHECK (owner_id = tv_current_user()
              AND EXISTS (SELECT 1 FROM users u WHERE u.id = owner_id AND u.role = 'OWNER' AND u.status = 'ACTIVE'));
CREATE POLICY documents_update ON "documents" FOR UPDATE TO trustvault_app
  USING (tv_doc_level(id, tv_current_user()) >= 2)
  WITH CHECK (true);  -- column-level rules: documents_guard_update below
CREATE POLICY documents_delete ON "documents" FOR DELETE TO trustvault_app
  USING (owner_id = tv_current_user());

CREATE POLICY versions_select ON "document_versions" FOR SELECT TO trustvault_app
  USING (tv_doc_level(document_id, tv_current_user()) >= 1);
CREATE POLICY versions_insert ON "document_versions" FOR INSERT TO trustvault_app
  WITH CHECK (uploaded_by_id = tv_current_user() AND tv_doc_level(document_id, tv_current_user()) >= 2);

CREATE POLICY blobs_select ON "document_blobs" FOR SELECT TO trustvault_app
  USING (EXISTS (SELECT 1 FROM document_versions v WHERE v.id = version_id AND tv_doc_level(v.document_id, tv_current_user()) >= 1));
CREATE POLICY blobs_insert ON "document_blobs" FOR INSERT TO trustvault_app
  WITH CHECK (EXISTS (SELECT 1 FROM document_versions v WHERE v.id = version_id AND tv_doc_level(v.document_id, tv_current_user()) >= 2));

-- Managers see and change grants on a document; anyone sees grants made to them.
CREATE POLICY grants_select ON "grants" FOR SELECT TO trustvault_app
  USING (user_id = tv_current_user() OR tv_doc_level(document_id, tv_current_user()) >= 3);
CREATE POLICY grants_insert ON "grants" FOR INSERT TO trustvault_app
  WITH CHECK (granted_by_id = tv_current_user() AND tv_doc_level(document_id, tv_current_user()) >= 3);
CREATE POLICY grants_update ON "grants" FOR UPDATE TO trustvault_app
  USING (tv_doc_level(document_id, tv_current_user()) >= 3)
  WITH CHECK (granted_by_id = tv_current_user() AND tv_doc_level(document_id, tv_current_user()) >= 3);
CREATE POLICY grants_delete ON "grants" FOR DELETE TO trustvault_app
  USING (tv_doc_level(document_id, tv_current_user()) >= 3);

CREATE POLICY folders_owner ON "folders" FOR ALL TO trustvault_app
  USING (owner_id = tv_current_user()) WITH CHECK (owner_id = tv_current_user());

CREATE POLICY break_glass_select ON "break_glass" FOR SELECT TO trustvault_app
  USING (admin_id = tv_current_user() OR tv_doc_level(document_id, tv_current_user()) >= 3);
CREATE POLICY break_glass_insert ON "break_glass" FOR INSERT TO trustvault_app
  WITH CHECK (admin_id = tv_current_user()
              AND EXISTS (SELECT 1 FROM users u WHERE u.id = admin_id AND u.role = 'ADMIN' AND u.status = 'ACTIVE'));

-- ---------- Rules the policies cannot express ----------
-- Only the owner may change ownership, status (trash or restore) or folder.
CREATE FUNCTION documents_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.owner_id IS DISTINCT FROM OLD.owner_id
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.folder_id IS DISTINCT FROM OLD.folder_id)
     AND OLD.owner_id IS DISTINCT FROM tv_current_user()
     AND NOT pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'documents'), 'MEMBER') THEN
    RAISE EXCEPTION 'only the owner may change owner, status or folder' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A new owner must be an active OWNER-role account.
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id AND NOT EXISTS (
       SELECT 1 FROM users u WHERE u.id = NEW.owner_id AND u.role = 'OWNER' AND u.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'new owner must be an active document owner' USING ERRCODE = 'check_violation';
  END IF;
  -- Folders are private to an owner; a document moved to a new owner leaves its folder.
  IF NEW.folder_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM folders f WHERE f.id = NEW.folder_id AND f.owner_id = NEW.owner_id) THEN
    NEW.folder_id := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER documents_guard_update BEFORE UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION documents_guard_update();

-- Grant rules: nobody grants above their own level (only the owner grants
-- MANAGE); no grants to the owner or to inactive users; external users get
-- READ only and always with an expiry.
CREATE FUNCTION grants_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  granter_level int;
  target users%ROWTYPE;
BEGIN
  granter_level := tv_doc_level(NEW.document_id, NEW.granted_by_id);
  IF granter_level < 3 THEN
    RAISE EXCEPTION 'granter lacks MANAGE on this document' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.level = 'MANAGE' AND granter_level < 4 THEN
    RAISE EXCEPTION 'only the owner can grant MANAGE' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.user_id IS NOT NULL THEN
    SELECT * INTO target FROM users WHERE id = NEW.user_id;
    IF NOT FOUND OR target.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'cannot grant to an inactive or unknown user' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM documents d WHERE d.id = NEW.document_id AND d.owner_id = NEW.user_id) THEN
      RAISE EXCEPTION 'the owner already has full access' USING ERRCODE = 'check_violation';
    END IF;
    IF target.role = 'EXTERNAL' AND (NEW.level <> 'READ' OR NEW.expires_at IS NULL) THEN
      RAISE EXCEPTION 'external users get READ only, with an expiry' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= now() THEN
    RAISE EXCEPTION 'expiry must be in the future' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER grants_guard BEFORE INSERT OR UPDATE ON "grants"
  FOR EACH ROW EXECUTE FUNCTION grants_guard();

-- External accounts cannot join groups.
CREATE FUNCTION group_members_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.role = 'EXTERNAL') THEN
    RAISE EXCEPTION 'external users cannot be group members' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER group_members_guard BEFORE INSERT OR UPDATE ON "group_members"
  FOR EACH ROW EXECUTE FUNCTION group_members_guard();

-- Checkpoints are evidence too: append-only.
CREATE TRIGGER "audit_checkpoints_no_update_delete" BEFORE UPDATE OR DELETE ON "audit_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION audit_block_change();
CREATE TRIGGER "audit_checkpoints_no_truncate" BEFORE TRUNCATE ON "audit_checkpoints"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_block_change();

-- ---------- Narrow system functions (bypass RLS, do one thing each) ----------
-- Title, owner and status of any document, for the admin break-glass form
-- and for showing document names in the admin audit view. Never content.
CREATE FUNCTION tv_document_brief(p_doc uuid)
RETURNS TABLE (id uuid, title text, owner_id uuid, status "DocumentStatus")
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.id, d.title, d.owner_id, d.status FROM documents d WHERE d.id = p_doc
$$;
GRANT EXECUTE ON FUNCTION tv_document_brief(uuid) TO trustvault_app;

-- Retention: permanently remove documents that have been in the trash
-- longer than p_days. Returns what was removed so the caller can audit it.
CREATE FUNCTION tv_purge_expired_trash(p_days int)
RETURNS TABLE (id uuid, owner_id uuid, title text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DELETE FROM documents d
   WHERE d.status = 'DELETED' AND d.deleted_at < now() - make_interval(days => greatest(p_days, 1))
  RETURNING d.id, d.owner_id, d.title
$$;
GRANT EXECUTE ON FUNCTION tv_purge_expired_trash(int) TO trustvault_app;

REVOKE ALL ON FUNCTION documents_guard_update(), grants_guard(), group_members_guard() FROM PUBLIC;
