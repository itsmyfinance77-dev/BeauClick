import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  BOOKING_CREDIT_GRANT_SOURCES,
  SELLER_SUBSCRIPTION_STATES,
  SUBSCRIBER_PARTY_TYPES,
  isPermittedSubscriptionTransition,
} from '@beauclick/commercial-policy-contract';

import { SUBSCRIPTION_AUDIT_REASONS, SYSTEM_ACTOR_LABEL } from './seller-subscription.audit';

/**
 * The structural boundaries of Story #56 (`#56a`), asserted against the source.
 *
 * ## Why these are file assertions rather than behaviour tests
 *
 * Each one guards a property that is true by ABSENCE — no expiry writer, no
 * seller route, no allowance constant, no free-text audit reason. A behaviour
 * test cannot observe an absence: it can only fail to observe a presence, which
 * is what a vacuous test looks like from the inside.
 *
 * The same reasoning `no-hardcoded-allowance.spec.ts` records for #40a, applied
 * to the four things `V33-DEC-018` forbids this story to contain.
 *
 * ## Every case here has a stated mutation probe
 *
 * A file assertion is worthless if it would pass against the code it forbids.
 * The probe for each is named in its docblock and was applied, observed failing,
 * and restored before commit — the same discipline #56a's real-PostgreSQL suite
 * uses for its planted-failure rollback case.
 */

const SUBSCRIPTION_DIR = __dirname;
const MIGRATION = resolve(
  __dirname,
  '../../../../database/migrations/commercial/20260903800001_create_seller_subscriptions.sql',
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/** Comments state what the code must not do; only executable lines are evidence that it does not. */
function executableLines(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0);
}

describe('subscription foundation — structural boundaries (#56a)', () => {
  const files = sourceFiles(SUBSCRIPTION_DIR);

  it('has source files to assert against', () => {
    // Guards every case below: a glob that silently matched nothing would make
    // all of them pass while proving nothing.
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  describe('grant expiry is structurally unwritable', () => {
    /**
     * Probe: add `expiresAt: new Date()` to the grant `create({ … })` in
     * `booking-credit-grant.service.ts`. This case fails.
     */
    it('mentions expiry in exactly three places, none of which writes one', () => {
      const mentions = files.flatMap((path) =>
        executableLines(path)
          .filter((line) => /\bexpires?_?[aA]t\b/.test(line))
          .map((line) => `${path.split(/[\\/]/).pop()}: ${line}`),
      );

      // The WHOLE set, rather than a filter narrowed down to empty. A filter is
      // where an exclusion quietly grows until it excuses the write it was
      // meant to catch; an exact set makes any new mention — including a
      // legitimate one — fail here and be read by a human.
      expect(mentions.sort()).toEqual([
        // The TypeORM column mapping. A declaration, not a write.
        "seller-subscription.entities.ts: @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })",
        'seller-subscription.entities.ts: expiresAt!: Date | null;',
        // The export projection, which COPIES the stored value out. It reads
        // `g.expiresAt` and cannot introduce one.
        'subscription-subject-data.contract.ts: expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,',
      ]);
    });

    /**
     * Probe: delete the CHECK from the migration. This case fails.
     *
     * The service-level absence above is defence; this constraint is the
     * guarantee, and it holds against raw SQL and future migrations.
     */
    it('the migration pins the column to NULL with a CHECK', () => {
      const sql = readFileSync(MIGRATION, 'utf8');
      expect(sql).toMatch(/CONSTRAINT ck_booking_credit_grants_no_expiry\s+CHECK \(expires_at IS NULL\)/);
    });
  });

  describe('no allowance, price or commercial value is a constant', () => {
    /**
     * Probe: change `INITIAL_GRANT_PERIOD_INDEX` to a defaulted allowance such
     * as `const DEFAULT_CREDITS = 200`. This case fails.
     *
     * `V33-DEC-009` names 200 specifically. The assertion is deliberately
     * wider: any numeric literal bound to a credit, seat, location, price or
     * term name is a commercial value that belongs to #46.
     */
    it('binds no numeric literal to a credit, seat, location, price or term name', () => {
      const forbidden =
        /\b(?:const|let|var|readonly)\s+[A-Za-z_]*(?:credit|allowance|seat|location|price|toman|term|quota)[A-Za-z_]*\s*(?::\s*number\s*)?=\s*\d+/i;
      const offenders = files.flatMap((path) =>
        executableLines(path)
          .filter((line) => forbidden.test(line))
          .map((line) => `${path}: ${line}`),
      );
      expect(offenders).toEqual([]);
    });

    /**
     * Probe: replace `subscription.snapshotIncludedBookingCredits` in the grant
     * service with a literal. Caught by the case above; this one additionally
     * proves the quantity is READ from the snapshot rather than computed.
     */
    it('takes the granted quantity from the subscription snapshot', () => {
      const service = readFileSync(join(SUBSCRIPTION_DIR, 'booking-credit-grant.service.ts'), 'utf8');
      expect(service).toContain('quantity: subscription.snapshotIncludedBookingCredits');
    });
  });

  describe('no seller-facing route exists in this story', () => {
    /**
     * Probe: add `@Controller('me/subscription')` to any file in this
     * directory. This case fails.
     *
     * #69 adds the routes. Until then the boundary is checkable against the
     * source rather than against intention.
     */
    it('declares no controller, route decorator or DTO', () => {
      const routeShaped = /@(?:Controller|Get|Post|Put|Patch|Delete|Body|Param|Query)\b/;
      const offenders = files.flatMap((path) =>
        executableLines(path)
          .filter((line) => routeShaped.test(line))
          .map((line) => `${path}: ${line}`),
      );
      expect(offenders).toEqual([]);
    });

    /** Probe: add `controllers: [X]` to the module. This case fails. */
    it('registers no controllers in the module', () => {
      const module = readFileSync(join(SUBSCRIPTION_DIR, 'seller-subscription.module.ts'), 'utf8');
      expect(module).not.toMatch(/controllers\s*:/);
    });
  });

  describe('audit reasons are closed and server-generated', () => {
    /**
     * Probe: add a `reason: string` parameter to `selectPlanVersion` and pass
     * it through to the audit call. This case fails.
     *
     * User-controlled prose must never reach `admin.admin_audit_log`: the
     * application holds INSERT and SELECT only and cannot remove a row it has
     * written, so an append-only log is worth having exactly to the extent that
     * nobody can write arbitrary content into it.
     */
    it('no public service method accepts a reason argument', () => {
      const service = readFileSync(join(SUBSCRIPTION_DIR, 'seller-subscription.service.ts'), 'utf8');
      const signatures = service.match(/^\s{2}async [a-zA-Z]+\([\s\S]*?\): Promise</gm) ?? [];
      expect(signatures.length).toBeGreaterThan(0);
      expect(signatures.filter((s) => /\breason\b/.test(s))).toEqual([]);
    });

    /** Probe: pass a template literal as a reason. This case fails. */
    it('audits exactly the declared constants, and nothing caller-supplied', () => {
      const declared = new Set<string>(Object.values(SUBSCRIPTION_AUDIT_REASONS));
      const sources = ['seller-subscription.service.ts', 'booking-credit-grant.service.ts'].map((name) =>
        readFileSync(join(SUBSCRIPTION_DIR, name), 'utf8'),
      );

      const values = sources
        .flatMap((source) => [...source.matchAll(/\breason: ([^,;\n]+)/g)].map((match) => match[1].trim()))
        // `reason: string` inside a parameter type is a SIGNATURE, not a value.
        // The public surface is covered by the case above, which proves no
        // public method accepts a reason at all.
        .filter((value) => value !== 'string');

      expect(values.length).toBeGreaterThan(0);

      // The exact set, not a predicate applied to each. A predicate that
      // accepted `input.reason` would keep accepting it if that field later
      // became caller-supplied; pinning the set makes such a change fail here.
      expect([...new Set(values)].sort()).toEqual([
        'SUBSCRIPTION_AUDIT_REASONS.baseWorkspaceAssigned',
        'SUBSCRIPTION_AUDIT_REASONS.baseWorkspaceRestored',
        'SUBSCRIPTION_AUDIT_REASONS.cancelledBySeller',
        'SUBSCRIPTION_AUDIT_REASONS.creditsGranted',
        'SUBSCRIPTION_AUDIT_REASONS.planVersionSelected',
        // The private `activate` helper's own narrowed field. Its only callers
        // pass the constants above, which this same set proves.
        'input.reason',
      ]);
      expect(declared.size).toBeGreaterThanOrEqual(6);
    });

    it('uses a fixed system label for actions no human took', () => {
      expect(SYSTEM_ACTOR_LABEL).toBe('system');
    });
  });

  describe('the vocabulary admits no paid or pending state', () => {
    /**
     * Probe: add `'pending_payment'` to `SELLER_SUBSCRIPTION_STATES`. This case
     * fails.
     *
     * `V33-DEC-018` refuses a dormant paid state by name. Asserting the whole
     * set rather than the absence of one member is what makes a fourth state
     * fail here rather than pass unnoticed.
     */
    it('has exactly three states, and they are the ratified three', () => {
      expect([...SELLER_SUBSCRIPTION_STATES]).toEqual(['active', 'superseded', 'cancelled']);
    });

    it('has exactly two subscriber party types', () => {
      expect([...SUBSCRIBER_PARTY_TYPES]).toEqual(['professional', 'business']);
    });

    it('has exactly one grant source until #57 adds custom purchases', () => {
      expect([...BOOKING_CREDIT_GRANT_SOURCES]).toEqual(['plan_included']);
    });

    /** Probe: make `PERMITTED_SUBSCRIPTION_TRANSITIONS.cancelled` include `'active'`. This case fails. */
    it('permits exactly two transitions and no return to active', () => {
      const all = SELLER_SUBSCRIPTION_STATES;
      const permitted = all.flatMap((from) =>
        all.filter((to) => isPermittedSubscriptionTransition(from, to)).map((to) => `${from}->${to}`),
      );
      expect(permitted.sort()).toEqual(['active->cancelled', 'active->superseded']);
    });
  });

  describe('the migration carries the invariants rather than the service', () => {
    const sql = () => readFileSync(MIGRATION, 'utf8');

    /** Probe: drop any one of these from the migration. The matching case fails. */
    it.each([
      ['one active subscription per party', /CREATE UNIQUE INDEX uq_seller_subscriptions_one_active_per_party[\s\S]*?WHERE lifecycle_state = 'active'/],
      ['zero price in every state', /CONSTRAINT ck_seller_subscriptions_zero_price\s+CHECK \(snapshot_unit_price_toman = 0\)/],
      ['one grant per subscription, source and period', /CONSTRAINT uq_booking_credit_grants_once\s+UNIQUE \(subscription_id, source, period_index\)/],
      ['snapshot immutability trigger', /CREATE TRIGGER tg_seller_subscriptions_immutable/],
      ['grant immutability trigger', /CREATE TRIGGER tg_booking_credit_grants_immutable/],
      ['the backfill block', /DO \$backfill\$[\s\S]*\$backfill\$;/],
    ])('declares %s', (_name, pattern) => {
      expect(sql()).toMatch(pattern as RegExp);
    });

    /**
     * Probe: change `RAISE EXCEPTION` in the backfill to `RETURN`. This case
     * fails.
     *
     * `V33-DEC-018`: an unconfigured base workspace fails explicitly rather
     * than assigning nothing quietly, because a silent skip leaves sellers with
     * no subscription — the implicit fallback the story exists to delete.
     */
    it('makes the backfill raise rather than skip when no base workspace is configured', () => {
      expect(sql()).toMatch(
        /IF base_version\.id IS NULL THEN\s*RAISE EXCEPTION 'no automatically assignable published plan version/,
      );
    });

    /** Probe: name `D-7` in any subscription source file. This case fails. */
    it('names no plan key in production code', () => {
      const offenders = files.flatMap((path) =>
        executableLines(path)
          .filter((line) => /['"`]D-7['"`]/.test(line))
          .map((line) => `${path}: ${line}`),
      );
      expect(offenders).toEqual([]);
    });
  });
});
