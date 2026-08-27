-- Bootstrap for the administrative audit log's PostgreSQL roles (GAP-02-V3).
--
-- Run ONCE per environment, as a superuser, BEFORE the admin migration.
-- Roles and grants are infrastructure, not application schema: they must be
-- created by someone with more authority than the application will ever have,
-- which is precisely what makes the resulting restriction meaningful. Same
-- reasoning, same shape, and deliberately the same file layout as
-- `financial-roles.sql` -- a second mechanism for the same guarantee would be
-- a second thing to get wrong.
--
--   psql -U postgres -d beauclick_v3_dev \
--        -v owner_password=... \
--        -v app_role=beauclick_app -v db_name=beauclick_v3_dev \
--        -f database/scripts/admin-audit-roles.sql
--
-- ONE role here, where financial needs three:
--
--   beauclick_admin_audit_owner  Owns the `admin` schema and its table, and
--                                applies its migrations. Nothing runs as this
--                                role at request time.
--
-- The application connects as its ordinary role and is granted INSERT + SELECT
-- on the audit table -- which is the complete access pattern, so no second
-- connection pool is needed. `financial` needs a separate pool because the
-- application role has ALL REVOKED on that schema and cannot even SELECT; here
-- reading the log IS a product feature (the admin audit-log screen), so SELECT
-- is granted deliberately.
--
-- What no role is granted, at all: UPDATE, DELETE, TRUNCATE. An audit trail
-- that the audited party can edit is not an audit trail.

\set ON_ERROR_STOP on

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beauclick_admin_audit_owner') THEN
        CREATE ROLE beauclick_admin_audit_owner NOLOGIN;
    END IF;
END
$$;

-- The password is supplied per environment via a psql variable and never
-- committed. A deployment that forgets to pass it fails loudly on the
-- unset-variable error rather than silently creating a passwordless role.
ALTER ROLE beauclick_admin_audit_owner PASSWORD :'owner_password' LOGIN;

-- Not a superuser. Granting SUPERUSER to make the immutability test pass would
-- defeat the entire exercise; the test asserts `usesuper = false` on the
-- connecting role so it cannot pass for the wrong reason.
ALTER ROLE beauclick_admin_audit_owner NOSUPERUSER;

GRANT CONNECT ON DATABASE :"db_name" TO beauclick_admin_audit_owner;

-- The owner needs CREATE on the database to create its schema. The application
-- role deliberately does not receive it here.
GRANT CREATE ON DATABASE :"db_name" TO beauclick_admin_audit_owner;

-- migrate.ts records every applied file in `public.schema_migrations`, and it
-- does so as WHICHEVER role applied that file -- which for this schema is the
-- owner role below. Without this grant the migration applies cleanly and then
-- fails on its own bookkeeping row with "permission denied for table
-- schema_migrations", rolling the whole thing back.
--
-- `financial-roles.sql` learned this the hard way (see its own note: the first
-- genuinely fresh CI database was the first environment ever to hit it). The
-- CREATE TABLE IF NOT EXISTS uses migrate.ts's identical DDL, so this script is
-- correct regardless of which of the two runs first.
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.schema_migrations TO beauclick_admin_audit_owner;
GRANT SELECT, INSERT ON public.schema_migrations TO :"app_role";

-- The schema is created HERE, by the owner, not by the migration -- so that
-- the default privileges below can be attached to it before any table exists.
-- The migration's own `CREATE SCHEMA IF NOT EXISTS` is then a no-op, which is
-- what makes running the two in either order safe.
CREATE SCHEMA IF NOT EXISTS admin AUTHORIZATION beauclick_admin_audit_owner;

-- If the schema pre-dated this script, make sure it is owned by the right role
-- rather than assuming it is.
ALTER SCHEMA admin OWNER TO beauclick_admin_audit_owner;

-- The application's access, stated exhaustively: it may read the log and append
-- to it. Nothing else.
GRANT USAGE ON SCHEMA admin TO :"app_role";
GRANT INSERT, SELECT ON ALL TABLES IN SCHEMA admin TO :"app_role";
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA admin FROM :"app_role";

-- The application must never create objects in this schema either -- a table it
-- owns is a table it can drop.
REVOKE CREATE ON SCHEMA admin FROM :"app_role";
REVOKE CREATE ON SCHEMA admin FROM PUBLIC;

-- The load-bearing half for a FRESH database, where the migration has not run
-- yet: anything the owner creates in `admin` from now on grants the application
-- exactly INSERT + SELECT, automatically. Without this the migration would
-- create a table the application cannot touch at all, and someone would "fix"
-- it by granting ALL.
ALTER DEFAULT PRIVILEGES FOR ROLE beauclick_admin_audit_owner IN SCHEMA admin
    GRANT INSERT, SELECT ON TABLES TO :"app_role";
