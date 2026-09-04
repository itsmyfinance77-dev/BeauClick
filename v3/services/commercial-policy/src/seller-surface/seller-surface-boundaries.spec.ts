import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { MANAGE_OWN_SUBSCRIPTION } from './seller-subscription-surface.controller';
import { EmptyBodyDto, EmptyQueryDto, SelectPlanVersionDto } from './seller-subscription-surface.dto';

/**
 * The structural boundaries of Story #69 (`#56b`), asserted against the source.
 *
 * ## Why these are file assertions rather than behaviour tests
 *
 * Each one guards a property that is true by ABSENCE — no raw identifier in a
 * request contract, no logger, no metric, no payment, no event. A behaviour
 * test cannot observe an absence: it can only fail to observe a presence, which
 * is what a vacuous test looks like from the inside.
 *
 * The same reasoning `subscription-boundaries.spec.ts` records for `#56a`,
 * applied to what `V33-DEC-019` forbids this surface to contain.
 *
 * ## Every case here has a stated mutation probe
 *
 * A file assertion is worthless if it would pass against the code it forbids.
 * The probe for each is named in its docblock and was applied, observed
 * failing, and restored before commit.
 */

const SURFACE_DIR = __dirname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
    .map((entry) => join(dir, entry));
}

/**
 * Comments state what the code must not do; only executable lines are evidence
 * that it does not.
 *
 * Splits on `\r?\n` rather than `'\n'`. See the same helper in
 * `subscription/subscription-boundaries.spec.ts` for why: a trailing `\r` from
 * a CRLF checkout defeats the `//` strip entirely, because `.` does not match a
 * line terminator and `$` without `m` matches only end-of-string. Every case
 * below would then be reading comments as if they were code.
 */
function executableLines(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0);
}

describe('seller subscription surface — structural boundaries (#69)', () => {
  const files = sourceFiles(SURFACE_DIR);
  const executable = files.flatMap((path) =>
    executableLines(path).map((line) => `${path.split(/[\\/]/).pop()}: ${line}`),
  );

  it('has source files to assert against', () => {
    // Guards every case below: a glob that silently matched nothing would make
    // all of them pass while proving nothing.
    expect(files.length).toBe(5);
    expect(executable.length).toBeGreaterThan(150);
  });

  describe('no route accepts an ownership selector', () => {
    /**
     * Probe: add `@IsString() ownerId!: string;` to `SelectPlanVersionDto`, or
     * `@Param('professionalId')` to any handler. This case fails.
     *
     * `V33-DEC-019` names all eight. The point is not that a check would refuse
     * a supplied id — it is that there is no field for one, so cross-party
     * access is unrepresentable rather than defended against.
     */
    it('names no user, owner, party or subscription identifier in any request contract', () => {
      const forbidden =
        /\b(?:userId|ownerId|professionalId|businessId|partyId|subscriberId|actorId|subscriptionId)\b/;
      const requestSurface = ['seller-subscription-surface.dto.ts', 'seller-subscription-surface.controller.ts'];

      const offenders = executable.filter(
        (line) => requestSurface.some((name) => line.startsWith(`${name}:`)) && forbidden.test(line),
      );

      // `user.userId` in a controller is the SESSION, not a caller-supplied
      // selector — so the set is pinned exactly rather than filtered, and any
      // new mention has to be read by a human before this passes again.
      expect(offenders.sort()).toEqual([
        'seller-subscription-surface.controller.ts: return { items: await this.surface.initialize(user.userId) };',
        'seller-subscription-surface.controller.ts: return { items: await this.surface.list(user.userId) };',
        'seller-subscription-surface.controller.ts: return { items: await this.surface.history(user.userId, workspaceRef) };',
        'seller-subscription-surface.controller.ts: return this.surface.cancel(user.userId, workspaceRef);',
        'seller-subscription-surface.controller.ts: return this.surface.select(user.userId, workspaceRef, dto.planKey, dto.version);',
      ].sort());
    });

    /** Probe: add any property to `EmptyBodyDto`. This case fails. */
    it('declares exactly the fields a caller may send, and no others', () => {
      // Reflected from the classes rather than read from the file, so a field
      // added through inheritance is caught too.
      expect(Object.keys(new EmptyBodyDto())).toEqual([]);
      expect(Object.keys(new EmptyQueryDto())).toEqual([]);

      const dto = new SelectPlanVersionDto();
      dto.planKey = 'x';
      dto.version = 1;
      expect(Object.keys(dto).sort()).toEqual(['planKey', 'version']);
    });
  });

  describe('no audit prose, no audit internals', () => {
    /**
     * Probe: add `reason: string` to `SelectPlanVersionDto` and pass it to
     * `applyPlanSelection`. This case fails.
     *
     * `admin.admin_audit_log` is owned by a role the application never connects
     * as, and the application holds INSERT and SELECT only. An append-only log
     * is worth having exactly to the extent that nobody can write arbitrary
     * content into it, so caller prose must not reach it.
     */
    it('accepts no reason, note or comment from a caller', () => {
      const offenders = executable.filter((line) => /\b(?:reason|note|comment|message)\s*[!?]?\s*:/.test(line));
      expect(offenders).toEqual([]);
    });

    /** Probe: return `auditId` or `actorUserId` from `toEntry`. This case fails. */
    it('projects no actor, audit or raw party identity into a response', () => {
      const projection = executable.filter((line) => line.startsWith('seller-subscription-surface.service.ts:'));
      const forbidden =
        /\b(?:auditId|actorUserId|createdByUserId|cancelledByUserId|supersededById|subscriberPartyId|planVersionId|ownerId)\b/;

      const offenders = projection.filter((line) => forbidden.test(line));

      // `planVersionId` and `subscriberPartyId` are READ (to answer "is this the
      // base workspace?" and to key a query); neither is projected. The exact
      // set is pinned so a new use has to be justified rather than absorbed.
      expect(offenders.sort()).toEqual([
        'seller-subscription-surface.service.ts: .findOne({ where: { id: subscription.planVersionId }, select: { id: true, autoAssignable: true } });',
      ]);
    });
  });

  describe('nothing here logs, measures or emits', () => {
    /**
     * Probe: add `private readonly logger = new Logger(...)` to the surface
     * service and log `workspaceRef`. This case fails.
     *
     * A `workspaceRef` in a log line or a metric label is a stable per-seller
     * identifier attached to everything else in that record, and the MAC input
     * behind it contains the owner's user id and the raw party id.
     */
    it('constructs no logger and reads no metric', () => {
      const offenders = executable.filter((line) =>
        /\b(?:Logger|console\.(?:log|info|warn|error|debug)|Counter|Histogram|Gauge|metrics?\.)\b/.test(line),
      );
      expect(offenders).toEqual([]);
    });

    /** Probe: import `EventEmitter2` or add an outbox insert. This case fails. */
    it('emits no event, schedules nothing, and touches no payment or financial concept', () => {
      const forbidden =
        /\b(?:outbox|emit|EventEmitter|Cron|Interval|Timeout|scheduler|paymentIntent|PaymentIntent|ledger|Ledger|settlement|Settlement|invoice|Invoice|gateway|Gateway|refund|Refund|OrderEntity)\b/;
      const offenders = executable.filter((line) => forbidden.test(line));
      expect(offenders).toEqual([]);
    });
  });

  describe('the secret is read once, and never leaves', () => {
    /**
     * Probe: change the module factory to read `JWT_ACCESS_SECRET`, or add a
     * second `config.get` for the workspace secret in the service. This case
     * fails.
     */
    it('reads WORKSPACE_REFERENCE_HMAC_SECRET in exactly one place', () => {
      const mentions = executable.filter((line) => line.includes('WORKSPACE_REFERENCE_HMAC_SECRET'));
      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toContain('seller-subscription-surface.module.ts');
    });

    /** Probe: add `JWT_ACCESS_SECRET` as a fallback in the module factory. This case fails. */
    it('names no other application secret', () => {
      const offenders = executable.filter((line) =>
        /\b(?:JWT_ACCESS_SECRET|OTP_HMAC_SECRET|MEDIA_UPLOAD_TOKEN_SECRET|MEDIA_DOWNLOAD_TOKEN_SECRET|METRICS_AUTH_TOKEN)\b/.test(
          line,
        ),
      );
      expect(offenders).toEqual([]);
    });

    /**
     * Probe: change the development fallback to
     * `dev-only-insecure-secret-override-in-env`, the literal `app.module.ts`
     * uses for the JWT. This case fails.
     *
     * Sharing that literal would make this secret EQUAL the token-signing
     * secret on every developer machine — the exact reuse the production
     * validator refuses — so the dedicated-secret property would hold only
     * where it is checked.
     */
    it('has a development fallback that is distinct and that production refuses by name', () => {
      const module = readFileSync(join(SURFACE_DIR, 'seller-subscription-surface.module.ts'), 'utf8');
      const fallback = module.match(/'(dev-only-[a-z-]+)'/)?.[1];

      expect(fallback).toBe('dev-only-insecure-workspace-reference-secret-override-in-env');
      expect(fallback).not.toBe('dev-only-insecure-secret-override-in-env');
      // Both fragments are in `FORBIDDEN_SECRET_FRAGMENTS`, so this value
      // cannot reach production. Asserted here rather than assumed, because the
      // fallback is only safe BECAUSE that list contains them.
      expect(fallback).toContain('dev-only');
      expect(fallback).toContain('insecure');
    });
  });

  describe('the capability contract', () => {
    /** Probe: rename the constant without updating the migration. This case fails. */
    it('is the one name the migration and the role map both use', () => {
      expect(MANAGE_OWN_SUBSCRIPTION).toBe('bc_manage_own_subscription');

      const migration = readFileSync(
        join(
          SURFACE_DIR,
          '../../../../database/migrations/identity/20260904800001_add_seller_subscription_capability.sql',
        ),
        'utf8',
      );
      expect(migration).toContain(`'${MANAGE_OWN_SUBSCRIPTION}'`);
      // NOT privileged, in the row itself. `V33-DEC-019` rules it, and this is
      // the column that carries it.
      expect(migration).toMatch(/'bc_manage_own_subscription',\s*'[^']*',\s*false\s*\)/);
      expect(migration).toContain("('professional', 'bc_manage_own_subscription')");
      expect(migration).toContain("('business',     'bc_manage_own_subscription')");
      expect(migration).not.toContain("('customer'");
    });

    /**
     * Probe: add `@RequireCapability(MANAGE_OWN_SUBSCRIPTION)` to the class, or
     * remove it from `cancel`. Either way this case fails.
     *
     * The EXACT set, not a count. `V33-DEC-019` puts the capability on the three
     * mutations and deliberately not on the reads, and a class-level decorator
     * — which `CapabilityGuard.getAllAndOverride` would honour — would gate the
     * reads too without anything else changing.
     */
    it('gates the three mutations and neither of the read routes', () => {
      const controller = readFileSync(join(SURFACE_DIR, 'seller-subscription-surface.controller.ts'), 'utf8');

      const decorated = [...controller.matchAll(/@RequireCapability\(MANAGE_OWN_SUBSCRIPTION\)\s*\n\s*async (\w+)/g)]
        .map((match) => match[1])
        .sort();
      expect(decorated).toEqual(['cancel', 'initialize', 'select']);

      // The decorator is never on a class, which is the form that would leak
      // onto the reads.
      expect(controller).not.toMatch(/@RequireCapability\([^)]*\)\s*\nexport class/);
    });
  });

  describe('the route family is exactly the ratified one', () => {
    /**
     * Probe: change `@Post('initialization')` to `@Post()`. This case fails.
     *
     * The route TABLE is asserted against the running application in
     * `seller-subscription-surface.pg-spec.ts`; this pins the declarations, so
     * a renamed path fails on the fast layer in a second rather than after a
     * container boot.
     */
    it('declares the six approved routes and no others', () => {
      const controller = readFileSync(join(SURFACE_DIR, 'seller-subscription-surface.controller.ts'), 'utf8');

      const controllers = [...controller.matchAll(/@Controller\('([^']+)'\)/g)].map((match) => match[1]);
      expect(controllers.sort()).toEqual(['v1/me/commercial-plans', 'v1/me/subscriptions']);

      const routes = [...controller.matchAll(/@(Get|Post|Put|Patch|Delete)\('?([^')]*)'?\)/g)].map(
        (match) => `${match[1]} ${match[2]}`,
      );
      expect(routes.sort()).toEqual(
        [
          'Get ',
          'Get ',
          'Get :workspaceRef/history',
          'Post :workspaceRef/cancellation',
          'Post :workspaceRef/selection',
          'Post initialization',
        ].sort(),
      );

      // No mutation verb this story does not have. A `PUT` or `DELETE` here
      // would be a lifecycle operation `V33-DEC-018` does not define.
      expect(controller).not.toMatch(/@(?:Put|Patch|Delete)\(/);
    });
  });
});
