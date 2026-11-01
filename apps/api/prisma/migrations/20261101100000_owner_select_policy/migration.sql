-- Fix: INSERT ... RETURNING on documents failed with "new row violates
-- row-level security policy". For RETURNING, Postgres also checks the new
-- row against the SELECT policy, and tv_doc_level() looks the document up
-- with a snapshot that cannot yet see the row being inserted, so it
-- returned 0 even for the owner.
--
-- The SELECT policy now also matches "the caller is the active owner of
-- this row" directly from the row's own columns. Same rule as before
-- (owners always see their documents); it no longer depends on reading
-- the row back.
DROP POLICY documents_select ON "documents";
CREATE POLICY documents_select ON "documents" FOR SELECT TO trustvault_app
  USING (
    (owner_id = tv_current_user()
       AND EXISTS (SELECT 1 FROM users u WHERE u.id = owner_id AND u.status = 'ACTIVE'
                     AND (u.access_expires_at IS NULL OR u.access_expires_at > now())))
    OR tv_doc_level(id, tv_current_user()) >= 1
  );
