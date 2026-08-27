/**
 * The one-time privileged bootstrap.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT AN API ROUTE
 * ---------------------------------------------------------------------------
 *
 * The first privileged account cannot be created by a privileged account,
 * because there is not one yet. Something has to break the circle, and the
 * options are:
 *
 *   (a) Seed a superuser into the database at migration time. Rejected: a
 *       permanent account with full authority and a password somebody wrote
 *       once is the single most-attacked thing a deployment can own, and V3's
 *       own security model (§9) says to default privileged accounts to the
 *       NARROWEST sufficient tier -- a seeded administrator is the opposite.
 *
 *   (b) An unauthenticated "claim ownership" endpoint that works until first
 *       use. Rejected: it is a race with the internet on every fresh deploy,
 *       and the window is exactly when nobody is watching.
 *
 *   (c) Require authority the application itself does not have -- database
 *       credentials. Chosen. Somebody holding the database password can
 *       already do anything; asking them to prove it is not a new trust
 *       assumption, it is the existing one made explicit.
 *
 * The grant is written through the SAME tables the application reads
 * (`identity.user_roles`), so nothing about it is special-cased at runtime, and
 * it writes an audit row with `actor_label = 'bootstrap'` -- so even the first
 * privileged action in a deployment's life is on the record.
 *
 * ---------------------------------------------------------------------------
 * SINGLE USE
 * ---------------------------------------------------------------------------
 *
 * The script refuses to run if any account already holds `platform_operator`
 * or `administrator`. That is what makes it a bootstrap rather than a back
 * door: once the platform has an operator, further grants go through the
 * audited, capability-gated API where they belong.
 *
 * `--force` exists for one real situation -- every operator account has been
 * lost -- and it requires `--reason`, which is recorded.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *
 *   DATABASE_URL=postgres://... \
 *   pnpm ts-node database/scripts/grant-platform-operator.ts \
 *     --phone +989121110001 \
 *     --reason "initial platform operator, approved by <name> on <date>"
 *
 * The account must already exist: the operator signs in through the ordinary
 * OTP flow first, then is granted. There is deliberately no account-creation
 * path here -- this script grants authority, it does not mint identities.
 */
import { Client } from 'pg';

interface Args {
  phone: string;
  reason: string;
  role: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const phone = get('phone');
  const reason = get('reason');
  const role = get('role') ?? 'platform_operator';
  const force = argv.includes('--force');

  if (!phone) throw new Error('--phone is required (the account must already exist).');
  if (!reason || reason.trim().length < 4) {
    throw new Error('--reason is required and must say who approved this and when. It is recorded permanently.');
  }
  if (role !== 'platform_operator' && role !== 'administrator') {
    throw new Error(`--role must be platform_operator or administrator; got "${role}".`);
  }
  if (role === 'administrator' && !force) {
    // Deliberate friction. V3_SECURITY_MODEL.md §9's standing practice is to
    // default privileged accounts to the narrowest sufficient tier, and an
    // administrator bootstrap should be an argued exception, not the easy path.
    throw new Error(
      'Refusing to bootstrap an administrator without --force. platform_operator is the intended tier ' +
        '(V3_SECURITY_MODEL.md §9); use --force only if you have a specific reason and record it in --reason.',
    );
  }

  return { phone, reason: reason.trim(), role, force };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');

  // `pg` directly, like migrate.ts -- this script is raw SQL against tables the
  // application owns, and pulling in TypeORM would add an ORM (and a dependency
  // the workspace root does not have) for no benefit.
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    await client.query('BEGIN');
    {
      // Existing privileged accounts. Counted inside the transaction so two
      // simultaneous bootstraps cannot both see zero.
      const existing = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM identity.user_roles
          WHERE role_slug IN ('platform_operator', 'administrator')`,
      );
      const privilegedAccounts = Number(existing.rows[0]?.count ?? '0');

      if (privilegedAccounts > 0 && !args.force) {
        throw new Error(
          `This platform already has ${privilegedAccounts} privileged account(s). ` +
            'The bootstrap is single-use by design -- grant further roles through ' +
            'POST /v1/admin/users/:id/roles, which is capability-gated and audited. ' +
            'Use --force only to recover from losing every operator account.',
        );
      }

      const users = await client.query<{ id: string; phone: string }>(
        `SELECT id, phone FROM identity.users WHERE phone = $1`,
        [args.phone],
      );
      if (users.rows.length === 0) {
        throw new Error(
          `No account exists for ${args.phone}. Sign in through the ordinary OTP flow first, then re-run this script. ` +
            'This script grants authority; it does not create identities.',
        );
      }
      const user = users.rows[0];

      const before = await client.query<{ role_slug: string }>(
        `SELECT role_slug FROM identity.user_roles WHERE user_id = $1 ORDER BY role_slug`,
        [user.id],
      );
      const beforeRoles = before.rows.map((r) => r.role_slug);

      if (beforeRoles.includes(args.role)) {
        // Idempotent, and says so rather than writing a second audit row for a
        // no-op.
        console.log(`${args.phone} already holds ${args.role}. Nothing to do.`);
        await client.query('COMMIT');
        return;
      }

      await client.query(
        `INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason)
         VALUES ($1, $2, NULL, $3)
         ON CONFLICT DO NOTHING`,
        [user.id, args.role, `bootstrap: ${args.reason}`],
      );

      const after = await client.query<{ role_slug: string }>(
        `SELECT role_slug FROM identity.user_roles WHERE user_id = $1 ORDER BY role_slug`,
        [user.id],
      );
      const afterRoles = after.rows.map((r) => r.role_slug);

      // The denormalized column, kept in sync during the expand window.
      await client.query(`UPDATE identity.users SET roles = $2 WHERE id = $1`, [user.id, afterRoles]);

      // Even the first grant is auditable. `actor_user_id` is NULL because
      // there genuinely is no session behind it; `actor_label` says what did it.
      await client.query(
        `INSERT INTO admin.admin_audit_log
           (id, actor_user_id, actor_label, action, target_type, target_id, before_state, after_state, reason)
         VALUES (gen_random_uuid(), NULL, 'bootstrap', 'identity.role_granted', 'user', $1, $2, $3, $4)`,
        [
          user.id,
          JSON.stringify({ roles: beforeRoles.join(',') }),
          JSON.stringify({ roles: afterRoles.join(','), role: args.role }),
          `bootstrap: ${args.reason}`,
        ],
      );

      console.log(`Granted ${args.role} to ${args.phone} (${user.id}).`);
      console.log(`Roles: ${beforeRoles.join(', ') || '(none)'} -> ${afterRoles.join(', ')}`);
      console.log('Recorded in admin.admin_audit_log with actor_label = bootstrap.');
      console.log('');
      console.log('The operator must sign out and back in (or wait for their access token to');
      console.log('refresh) before the new capabilities appear in their session.');
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
