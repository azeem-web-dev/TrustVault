-- Test database for CI: the same role layout as production, so row-level
-- security and the audit triggers behave exactly as they do on the server.
CREATE ROLE trustvault_app NOLOGIN;
CREATE ROLE tv_dev_owner LOGIN PASSWORD 'ci-owner' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE tv_dev_app LOGIN PASSWORD 'ci-app' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
GRANT trustvault_app TO tv_dev_app;
CREATE DATABASE trustvault_test OWNER tv_dev_owner;
\connect trustvault_test
REVOKE ALL ON DATABASE trustvault_test FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE trustvault_test TO tv_dev_owner;
GRANT CONNECT ON DATABASE trustvault_test TO tv_dev_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO tv_dev_owner;
GRANT USAGE ON SCHEMA public TO tv_dev_app;
