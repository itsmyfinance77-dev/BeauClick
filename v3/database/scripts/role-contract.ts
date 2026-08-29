/**
 * The PostgreSQL role contract, as executable assertions (`HOSTING_GRANTS`,
 * `PHASE4-03`).
 *
 * ## Why this exists
 *
 * `V3_INFRASTRUCTURE_PLAN.md` §4 states a hard precondition: the chosen
 * managed-Postgres provider must grant the role-level permissions the ledger's
 * immutability rests on, and it must be checked "against the actual target
 * environment, not assumed from the provider's marketing material". V2's MySQL
 * hosting silently lacked the grants its trigger-based approach needed,
 * append-only stayed a code convention, and that is `GAP-01`.
 *
 * Until now the only thing that could make that check was the real-Postgres
 * test suite -- which needs a checkout, a package install, a migrated
 * database, and a test runner. None of those are things anyone wants to do
 * against a production host, and several are things nobody should. So
 * `HOSTING_GRANTS` has been described as "one script, one afternoon, once a
 * host exists" while no such script existed.
 *
 * `verify-roles.ts` is the command; this file is what it asserts, exported so
 * the real-Postgres suite runs the SAME checks. One definition, two callers: a
 * check that passes only in a script rots, and a check only CI can run is a
 * check nobody can run against the real host.
 *
 * ## What running this does NOT do
 *
 * **Passing against CI's ephemeral container does not close `HOSTING_GRANTS`.**
 * That gap asks for the contract proven on the REAL target host, and no host
 * has been selected. What CI proves is that the script works and that the
 * contract holds wherever it has been applied -- so the day a host exists, the
 * remaining work is one command rather than an afternoon of hand-written psql.
 *
 * ## Why it needs no superuser
 *
 * Every check is a catalog read plus `has_table_privilege(role, oid, priv)`.
 * Addressing tables by OID rather than by `schema.table` NAME is deliberate
 * and load-bearing: the name form has to resolve the schema, which requires
 * the CALLER to hold USAGE on it -- and the whole point of the contract is
 * that the application role does not hold USAGE on `financial`. Written the
 * obvious way, this would fail with "permission denied for schema financial"
 * on precisely the databases where the contract is correct.
 *
 * So it runs as the ordinary application role, which matters for a managed
 * provider that may never hand out a superuser at all.
 */
import { Client } from 'pg';

const APP_ROLE = process.env.VERIFY_APP_ROLE ?? 'beauclick_app';
const FINANCIAL_OWNER = 'beauclick_financial_owner';
const FINANCIAL_WRITER = 'beauclick_financial_writer';
const FINANCIAL_READER = 'beauclick_financial_reader';
const AUDIT_OWNER = 'beauclick_admin_audit_owner';

export interface RoleCheck {
  /** Stable id, so a failure can be cited in a runbook or a gap register. */
  id: string;
  /** What the check asserts, in the terms the ADR uses. */
  description: string;
  passed: boolean;
  /** What was found, when it differs from what was required. Never a credential. */
  detail: string | null;
}

interface TableFacts {
  schema: string;
  table: string;
  owner: string;
  privileges: Record<string, Record<string, boolean>>;
}

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;
const ROLES = [APP_ROLE, FINANCIAL_OWNER, FINANCIAL_WRITER, FINANCIAL_READER, AUDIT_OWNER];

/**
 * The role contract, as executable assertions.
 *
 * Exported so the real-Postgres suite runs the SAME checks this script does.
 * One definition, two callers: a check that passes here and is absent from CI
 * is a check that rots, and a check CI runs that this script cannot is a check
 * nobody can run against the real host.
 */
export async function verifyRoleContract(client: Client): Promise<RoleCheck[]> {
  const checks: RoleCheck[] = [];
  const add = (id: string, description: string, passed: boolean, detail: string | null = null): void => {
    checks.push({ id, description, passed, detail });
  };

  // ---- Roles exist and none of them is a superuser -----------------------
  const { rows: roleRows } = await client.query<{ rolname: string; rolsuper: boolean }>(
    `SELECT rolname, rolsuper FROM pg_roles WHERE rolname = ANY($1::text[])`,
    [ROLES],
  );
  const roleByName = new Map(roleRows.map((r) => [r.rolname, r]));

  for (const role of ROLES) {
    const found = roleByName.get(role);
    add(`role.${role}.exists`, `Role ${role} exists`, found !== undefined, found ? null : 'role not found');
    if (found) {
      // Granting SUPERUSER to make an immutability check pass would defeat the
      // entire exercise, and a managed provider handing one out by default is
      // exactly the kind of thing marketing material does not mention.
      add(
        `role.${role}.not_superuser`,
        `Role ${role} is not a superuser`,
        found.rolsuper === false,
        found.rolsuper ? 'role is SUPERUSER, which bypasses every grant below' : null,
      );
    }
  }

  // ---- Schema ownership --------------------------------------------------
  const { rows: schemaRows } = await client.query<{ nspname: string; owner: string }>(
    `SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner
       FROM pg_namespace n WHERE n.nspname = ANY($1::text[])`,
    [['financial', 'admin', 'public']],
  );
  const schemaOwner = new Map(schemaRows.map((r) => [r.nspname, r.owner]));

  for (const [schema, expected] of [
    ['financial', FINANCIAL_OWNER],
    ['admin', AUDIT_OWNER],
  ] as const) {
    const owner = schemaOwner.get(schema);
    add(
      `schema.${schema}.owner`,
      `Schema ${schema} is owned by ${expected}`,
      owner === expected,
      owner === undefined ? 'schema does not exist' : owner === expected ? null : `owned by ${owner}`,
    );
  }

  // ---- Table facts, addressed by OID -------------------------------------
  const facts = await tableFacts(client, ['financial', 'admin']);
  const financial = facts.filter((f) => f.schema === 'financial');
  const admin = facts.filter((f) => f.schema === 'admin');

  add('schema.financial.has_tables', 'The financial schema contains tables', financial.length > 0, financial.length === 0 ? 'no tables found — has the migration run?' : null);
  add('schema.admin.has_tables', 'The admin schema contains tables', admin.length > 0, admin.length === 0 ? 'no tables found — has the migration run?' : null);

  for (const table of [...financial, ...admin]) {
    const expectedOwner = table.schema === 'financial' ? FINANCIAL_OWNER : AUDIT_OWNER;
    // An owner can always grant itself back UPDATE. Ownership is therefore the
    // load-bearing half of the contract, not the grants -- an
    // application-owned ledger is one statement away from being mutable.
    add(
      `table.${table.schema}.${table.table}.owner`,
      `${table.schema}.${table.table} is owned by ${expectedOwner}`,
      table.owner === expectedOwner,
      table.owner === expectedOwner ? null : `owned by ${table.owner}`,
    );
  }

  // ---- The ledger's append-only guarantee ---------------------------------
  const ledger = financial.find((f) => f.table === 'ledger_entries');
  if (!ledger) {
    add('ledger.present', 'financial.ledger_entries exists', false, 'table not found');
  } else {
    add('ledger.present', 'financial.ledger_entries exists', true);
    add('ledger.writer.insert', `${FINANCIAL_WRITER} may INSERT ledger entries`, ledger.privileges[FINANCIAL_WRITER]?.INSERT === true);
    add('ledger.writer.select', `${FINANCIAL_WRITER} may SELECT ledger entries`, ledger.privileges[FINANCIAL_WRITER]?.SELECT === true);

    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) {
      add(
        `ledger.writer.no_${privilege.toLowerCase()}`,
        `${FINANCIAL_WRITER} may NOT ${privilege} ledger entries`,
        ledger.privileges[FINANCIAL_WRITER]?.[privilege] === false,
        ledger.privileges[FINANCIAL_WRITER]?.[privilege] ? `${privilege} is granted — the ledger is not append-only here` : null,
      );
    }

    add('ledger.reader.select', `${FINANCIAL_READER} may SELECT ledger entries`, ledger.privileges[FINANCIAL_READER]?.SELECT === true);
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      add(
        `ledger.reader.no_${privilege.toLowerCase()}`,
        `${FINANCIAL_READER} may NOT ${privilege} ledger entries`,
        ledger.privileges[FINANCIAL_READER]?.[privilege] === false,
      );
    }

    // The application role must not reach the ledger AT ALL. This is what
    // makes the second DataSource (ADR-017) meaningful rather than decorative:
    // if the shared pool could read the ledger, isolating the writer would be
    // a convention.
    for (const privilege of PRIVILEGES) {
      add(
        `ledger.app.no_${privilege.toLowerCase()}`,
        `${APP_ROLE} may NOT ${privilege} ledger entries`,
        ledger.privileges[APP_ROLE]?.[privilege] === false,
        ledger.privileges[APP_ROLE]?.[privilege] ? `the application role holds ${privilege} on the ledger` : null,
      );
    }
  }

  const { rows: usageRows } = await client.query<{ has_usage: boolean }>(
    `SELECT has_schema_privilege($1, 'financial', 'USAGE') AS has_usage`,
    [APP_ROLE],
  );
  add(
    'schema.financial.app_no_usage',
    `${APP_ROLE} has no USAGE on the financial schema`,
    usageRows[0]?.has_usage === false,
    usageRows[0]?.has_usage ? 'the application role can reach the financial schema' : null,
  );

  // ---- The administrative audit log --------------------------------------
  for (const table of admin) {
    add(`audit.${table.table}.app_insert`, `${APP_ROLE} may INSERT into admin.${table.table}`, table.privileges[APP_ROLE]?.INSERT === true);
    add(`audit.${table.table}.app_select`, `${APP_ROLE} may SELECT from admin.${table.table}`, table.privileges[APP_ROLE]?.SELECT === true);
    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) {
      add(
        `audit.${table.table}.app_no_${privilege.toLowerCase()}`,
        `${APP_ROLE} may NOT ${privilege} admin.${table.table}`,
        table.privileges[APP_ROLE]?.[privilege] === false,
        table.privileges[APP_ROLE]?.[privilege] ? `${privilege} is granted — the audit trail is editable by the application` : null,
      );
    }
  }

  const { rows: adminCreate } = await client.query<{ has_create: boolean }>(
    `SELECT has_schema_privilege($1, 'admin', 'CREATE') AS has_create`,
    [APP_ROLE],
  );
  add(
    'schema.admin.app_no_create',
    `${APP_ROLE} may not create objects in the admin schema`,
    adminCreate[0]?.has_create === false,
    // A table it owns is a table it can drop, which would make the audit trail
    // deletable by the thing being audited.
    adminCreate[0]?.has_create ? 'the application role can create objects in admin, and therefore own and drop them' : null,
  );

  // ---- PHASE4-03 ---------------------------------------------------------
  const { rows: publicCreate } = await client.query<{ has_create: boolean }>(
    `SELECT has_schema_privilege($1, 'public', 'CREATE') AS has_create`,
    [APP_ROLE],
  );
  add(
    'schema.public.app_create',
    `${APP_ROLE} may create in the public schema (PHASE4-03)`,
    publicCreate[0]?.has_create === true,
    // PostgreSQL 15+ stopped granting this to PUBLIC by default, and
    // database-level ALL does not include it. `migrate.ts` creates
    // `public.schema_migrations`, so without this the FIRST migration on a
    // fresh 15+ host fails with "permission denied for schema public".
    publicCreate[0]?.has_create ? null : 'migrate.ts cannot create public.schema_migrations on this host',
  );

  // ---- Default privileges for tables that do not exist yet ---------------
  const { rows: defaultAcls } = await client.query<{ owner: string; schema: string; acl: string[] }>(
    `SELECT pg_get_userbyid(d.defaclrole) AS owner,
            n.nspname AS schema,
            d.defaclacl::text[] AS acl
       FROM pg_default_acl d
       JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE d.defaclobjtype = 'r'`,
  );

  for (const [schema, owner, grantee, expected] of [
    ['financial', FINANCIAL_OWNER, FINANCIAL_WRITER, /a?r?[aw]/],
    ['admin', AUDIT_OWNER, APP_ROLE, /a?r/],
  ] as const) {
    const entry = defaultAcls.find((d) => d.schema === schema && d.owner === owner);
    const acl = (entry?.acl ?? []).find((a) => a.startsWith(`${grantee}=`));
    add(
      `default_acl.${schema}.${grantee}`,
      `Future tables in ${schema} created by ${owner} grant ${grantee} automatically`,
      acl !== undefined && expected.test(acl),
      // Without this, a migration that forgets its own GRANT block ships a
      // table the application cannot touch -- and somebody "fixes" it by
      // granting ALL.
      acl === undefined ? 'no default privilege recorded' : null,
    );
  }

  return checks;
}

async function tableFacts(client: Client, schemas: string[]): Promise<TableFacts[]> {
  const { rows } = await client.query<{ oid: number; schema: string; table: string; owner: string }>(
    `SELECT c.oid, n.nspname AS schema, c.relname AS "table", pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[]) AND c.relkind = 'r'
      ORDER BY n.nspname, c.relname`,
    [schemas],
  );

  const facts: TableFacts[] = [];
  for (const row of rows) {
    const privileges: Record<string, Record<string, boolean>> = {};
    for (const role of ROLES) {
      const answers: Record<string, boolean> = {};
      for (const privilege of PRIVILEGES) {
        // Addressed by OID. See the file header: the NAME form needs schema
        // USAGE from the CALLER, which the application role deliberately
        // lacks on `financial`.
        const { rows: answer } = await client.query<{ allowed: boolean }>(
          `SELECT has_table_privilege($1, $2::oid, $3) AS allowed`,
          [role, row.oid, privilege],
        );
        answers[privilege] = answer[0]?.allowed === true;
      }
      privileges[role] = answers;
    }
    facts.push({ schema: row.schema, table: row.table, owner: row.owner, privileges });
  }
  return facts;
}

export function formatChecks(checks: readonly RoleCheck[]): string {
  const lines = checks.map((c) => `  ${c.passed ? 'PASS' : 'FAIL'}  ${c.id}  ${c.description}${c.detail ? ` — ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.passed).length;
  return [
    `PostgreSQL role contract: ${checks.length - failed}/${checks.length} checks passed`,
    ...lines,
    failed === 0
      ? 'All checks passed for THIS host. HOSTING_GRANTS closes only when this runs against the real production target.'
      : `${failed} check(s) FAILED. The append-only ledger guarantee does not hold on this host.`,
  ].join('\n');
}
