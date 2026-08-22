-- Bootstrap for financial-service's PostgreSQL roles (ADR-009 / ADR-017).
--
-- Run ONCE per environment, as a superuser, BEFORE the financial migration.
-- Roles and grants are infrastructure, not application schema: they must be
-- created by someone with more authority than the application will ever have,
-- which is precisely what makes the resulting restriction meaningful.
--
--   psql -U postgres -d beauclick_v3_dev \
--        -v owner_password=... -v writer_password=... -v reader_password=... \
--        -v app_role=beauclick_app -v db_name=beauclick_v3_dev \
--        -f database/scripts/financial-roles.sql
--
-- Why THREE roles rather than two:
--
--   beauclick_financial_owner   NOLOGIN. Owns the financial schema and its
--                               tables. Applies migrations (via a connection
--                               that SETs ROLE to it). Nothing runs as this
--                               role at request time.
--   beauclick_financial_writer  What financial-service connects as. INSERT +
--                               SELECT only. It is NOT the owner, so it
--                               cannot grant itself UPDATE -- an owner always
--                               can, which is exactly why the application
--                               role must not be the owner.
--   beauclick_financial_reader  SELECT only, for reporting/reconciliation.
--
-- V2 could never reach this shape: its MySQL hosting lacked the SUPER /
-- log_bin_trust_function_creators grants its trigger approach needed, so
-- append-only remained a code-level convention (GAP-01). V3 owns its
-- database, so the guarantee is a grant.

\set ON_ERROR_STOP on

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beauclick_financial_owner') THEN
        CREATE ROLE beauclick_financial_owner NOLOGIN;
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beauclick_financial_writer') THEN
        CREATE ROLE beauclick_financial_writer LOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beauclick_financial_reader') THEN
        CREATE ROLE beauclick_financial_reader LOGIN;
    END IF;
END
$$;

-- Passwords are supplied per environment via psql variables and never
-- committed. A deployment that forgets to pass them fails loudly on the
-- unset-variable error rather than silently creating a passwordless role.
ALTER ROLE beauclick_financial_owner  PASSWORD :'owner_password' LOGIN;
ALTER ROLE beauclick_financial_writer PASSWORD :'writer_password';
ALTER ROLE beauclick_financial_reader PASSWORD :'reader_password';

-- None of them are superusers. Granting SUPERUSER to make the immutability
-- test pass would defeat the entire exercise, so the test asserts
-- `usesuper = false` explicitly.
ALTER ROLE beauclick_financial_owner  NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE beauclick_financial_writer NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE beauclick_financial_reader NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- The owner needs CREATE on the database to create its schema, and INSERT on
-- the shared migration ledger so a financial migration's DDL and its
-- bookkeeping row commit in ONE transaction (otherwise a crash between the
-- two leaves a migration applied but unrecorded, and the re-run fails on
-- "already exists").
--
-- This script's own usage note says "run BEFORE the financial migration" --
-- which means BEFORE `migrate.ts` has ever run on a truly fresh database, so
-- the table this GRANT targets does not exist yet. Every prior run of this
-- script happened to find it already there (a persistent dev database that
-- had been migrated before), which is exactly why a genuinely fresh CI
-- database was the first environment to ever hit `relation "public.
-- schema_migrations" does not exist`. Creating it here, with the identical
-- DDL `migrate.ts` uses, makes this script correct regardless of which of
-- the two runs first -- migrate.ts's own `CREATE TABLE IF NOT EXISTS` is a
-- no-op against a table this already created.
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT CREATE ON DATABASE :"db_name" TO beauclick_financial_owner;
GRANT SELECT, INSERT ON public.schema_migrations TO beauclick_financial_owner;

-- The general application role (`:app_role` -- `beauclick_app` in this
-- project's own environments) needs the SAME grant, for the OPPOSITE
-- reason: this script runs as a superuser and therefore OWNS whatever it
-- just created above, which means the general role -- migrate.ts's normal
-- caller for every non-financial migration -- would otherwise have no
-- grant on a table it needs to INSERT its own bookkeeping rows into. This
-- is the second half of the exact bug the CREATE TABLE above was written
-- to fix: creating the table here solved "does not exist" but, without
-- this grant, immediately replaced it with "permission denied for table
-- schema_migrations" for the ordinary migration role. A superuser's GRANT
-- is not limited by table ownership, so this succeeds regardless of who
-- ends up owning the row.
GRANT SELECT, INSERT ON public.schema_migrations TO :"app_role";

-- The schema itself is created here, owned by the owner role, so the
-- migration that populates it never has to run as anyone more privileged.
CREATE SCHEMA IF NOT EXISTS financial AUTHORIZATION beauclick_financial_owner;

-- Future tables in the financial schema inherit the same restriction
-- automatically, so a migration that forgets its GRANT block cannot
-- accidentally ship a mutable financial table.
ALTER DEFAULT PRIVILEGES FOR ROLE beauclick_financial_owner IN SCHEMA financial
    GRANT INSERT, SELECT ON TABLES TO beauclick_financial_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE beauclick_financial_owner IN SCHEMA financial
    GRANT SELECT ON TABLES TO beauclick_financial_reader;
