-- An invited account has never been activated (see the previous migration;
-- the INVITED value could not be used in the same transaction that added it).
ALTER TABLE "users" ADD CONSTRAINT "users_invited_not_activated" CHECK ("status" <> 'INVITED' OR "activated_at" IS NULL);
