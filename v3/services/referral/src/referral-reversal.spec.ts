import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  ALL_EVENT_CONTRACTS,
  REFERRAL_REVERSAL_OUTCOMES,
  REFERRAL_REWARD_SIDES,
  ReferralReversed,
} from '@beauclick/event-contracts';

import { REFERRAL_STATUSES } from './entities/referral.entities';

const sourceOf = (...segments: string[]) => readFileSync(join(__dirname, ...segments), 'utf8');

/**
 * The source with comments removed.
 *
 * The same helper `referral-qualification.spec.ts` and
 * `referral-attribution.spec.ts` both carry, for the reason the first records
 * at length: several assertions here forbid an identifier from appearing in a
 * file, and a raw source match cannot tell a REFERENCE from an EXPLANATION of
 * why there is no reference. This codebase documents its absences deliberately,
 * so a rule aimed at the raw text fails on its own docblocks.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const codeOf = (...segments: string[]) => stripComments(sourceOf(...segments));

const migrationOf = (name: string) =>
  readFileSync(join(__dirname, '..', '..', '..', 'database', 'migrations', 'referral', name), 'utf8');

/**
 * The migration with its SQL comments removed.
 *
 * The same trap `stripComments` exists for, in the other language: this
 * repository's migrations explain their absences at length, and the header of
 * this one says at length why it touches NO loyalty and NO financial object.
 * A raw-text rule aimed at those words fails on the paragraph explaining that
 * they are not there.
 */
const migrationCodeOf = (name: string): string =>
  migrationOf(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');

/**
 * The parts of Story #28 that are vocabulary, contract, or structure (ADR-038).
 *
 * Everything that needs a real database — the compare-and-swap, the trigger,
 * the append-only ledger, the transaction boundary, the `FOR SHARE` lock that
 * closes the ordering race — lives in
 * `apps/api/test/referral-reversal.pg-spec.ts` and cannot honestly be proved
 * here: pg-mem has no triggers, no `FOR SHARE`, and does not honour `ROLLBACK`.
 */

describe('the reversal vocabulary', () => {
  it('is a closed set with exactly the two members ADR-038 freezes', () => {
    expect([...REFERRAL_REVERSAL_OUTCOMES]).toEqual(['reversed', 'nothing_to_reverse']);
  });

  it('carries no free-form, failure, or partial member', () => {
    // A reversal takes back the whole award or does not happen: the
    // transaction commits every effect or none of them (ADR-038 §7). `partial`
    // and `failed` would each be a state the transaction cannot produce, and
    // `unknown` would be an outcome nobody could act on.
    for (const outcome of REFERRAL_REVERSAL_OUTCOMES) {
      expect(outcome).not.toMatch(/partial|failed|pending|unknown|other|custom/i);
    }
  });

  it('adds `reversed` to the referral lifecycle, in order and once', () => {
    expect([...REFERRAL_STATUSES]).toEqual(['pending', 'qualified', 'reversed']);
    expect(REFERRAL_STATUSES.filter((s) => s === 'reversed')).toHaveLength(1);
  });
});

describe('the ledger reversal reasons', () => {
  const migration = migrationOf('20260901700004_create_referral_reversal.sql');

  it('are TWO distinct reasons, one per side', () => {
    // The ledger's idempotency is `UNIQUE(reference_type, reference_id,
    // reason)`, so one reason cannot idempotently claw back from two people
    // against one referral id -- the same argument `V32-DEC-016` makes for the
    // two REWARD reasons, applied in the other direction.
    const source = codeOf('referral-reversal.service.ts');
    expect(source).toContain("referrer: 'referral_referrer_reversal'");
    expect(source).toContain("referee: 'referral_referee_reversal'");
  });

  it('DIFFER from the reward reasons they reverse', () => {
    // The single most important property in this file. A reversal written under
    // the AWARD's reason would collide with the award itself on the unique
    // index, be deduplicated away, and leave the points in place -- surfacing
    // as "we refunded the order and the points are still there".
    const source = codeOf('referral-reversal.service.ts');
    for (const [reward, reversal] of [
      ['referral_referrer_reward', 'referral_referrer_reversal'],
      ['referral_referee_reward', 'referral_referee_reversal'],
    ]) {
      expect(reward).not.toBe(reversal);
      expect(source).toContain(reward);
      expect(source).toContain(reversal);
    }
  });

  it('reference the REFERRAL id, never the booking and never the order', () => {
    // The reversal shares its reference with the award it reverses, which is
    // what makes the two rows findable as one account of what a referral did to
    // a balance. The booking id would express one reversal per BOOKING, and the
    // order id would put a commerce identifier into the loyalty ledger's
    // namespace.
    const source = codeOf('referral-reversal.service.ts');
    expect(source).toContain('referenceType: REFERRAL_LEDGER_REFERENCE_TYPE');
    expect(source).toContain('referenceId: referralId');
    expect(source).not.toMatch(/referenceId:\s*(input\.)?(bookingId|orderId)/);
  });

  it('are recorded as columns the database constrains, not as free text', () => {
    expect(migration).toContain("CHECK (outcome IN ('reversed', 'nothing_to_reverse'))");
    expect(migration).toContain('ledger_reason VARCHAR(64) NOT NULL');
  });
});

describe('the reversal compare-and-swap', () => {
  const source = codeOf('referral-reversal.service.ts');

  it('predicates strictly on the QUALIFIED state', () => {
    // The only guard, and everything else lives in its success branch: a
    // redelivered event, a pending referral, one already reversed, and a refund
    // for an order no referral concerns all cost one UPDATE affecting zero rows.
    expect(source).toContain("AND status = 'qualified'");
    // Never on the reversed state -- a predicate that matched an already
    // reversed row would make redelivery write a second event.
    expect(source).not.toMatch(/WHERE[\s\S]{0,120}status\s*=\s*'reversed'/);
  });

  it('sets the status and BOTH reversal facts in one statement', () => {
    // `ck_referrals_reversal_complete` requires all three to move together, so
    // splitting them across statements would fail at the database rather than
    // leave a torn row -- but it would fail in production, mid-refund. One
    // statement makes the torn state unreachable rather than merely refused.
    const update = source.slice(source.indexOf('UPDATE referral.referrals'));
    const statement = update.slice(0, update.indexOf('RETURNING'));
    expect(statement).toContain("status = 'reversed'");
    expect(statement).toContain('reversed_at');
    expect(statement).toContain('reversal_order_id');
  });

  it('reads the affected-row count through returningRows, never result.length', () => {
    // TypeORM's postgres driver returns `[rows, rowCount]` for UPDATE even with
    // RETURNING, so `result.length` is always 2 and a guard reading it never
    // fires. That exact mistake has shipped twice in this repository, once
    // letting a revoked refresh token mint a session.
    expect(source).toContain('returningRows');
    expect(source).not.toMatch(/\braw\.length\b/);
    expect(source).not.toMatch(/\bresult\.length\b/);
  });
});

describe('the clawback amount', () => {
  const source = codeOf('referral-reversal.service.ts');
  const port = codeOf('ports', 'referral-loyalty-reversal.port.ts');

  it('is never computed from the reward CONFIGURATION', () => {
    // `V32-DEC-017` requires the clawback to be exactly what was given, and
    // reward configuration may legitimately change between the award and the
    // refund. The reversal service must not read the configured values at all.
    expect(source).not.toContain('REFERRAL_REWARD_CONFIG');
    expect(source).not.toContain('ReferralRewardConfig');
    // Word-bounded, so the event payload's `referrerPointsReversed` -- which is
    // the MAGNITUDE the ledger reported and not a configured value -- is not
    // mistaken for a config read.
    expect(source).not.toMatch(/\breferrerPoints\b/);
    expect(source).not.toMatch(/\brefereePoints\b/);
  });

  it('is not even an INPUT to the port — the ledger reads it', () => {
    // The strongest form of the guarantee: with no `points` field on the port's
    // input, an over-claw has no parameter to arrive through. `expectedBasePoints`
    // is a CROSS-CHECK, and the name says so.
    const inputBlock = port.slice(
      port.indexOf('interface ReferralLoyaltyReversal '),
      port.indexOf('interface ReferralLoyaltyReversalPort'),
    );
    expect(inputBlock).not.toMatch(/^\s*readonly points\b/m);
    expect(inputBlock).toContain('expectedBasePoints');
  });

  it('cross-checks the GRANT against the ledger rather than trusting either', () => {
    expect(source).toContain('expectedBasePoints: grant.points');
    expect(codeOf('..', '..', '..', 'services', 'loyalty', 'src', 'loyalty-ledger.service.ts')).toContain(
      'input.expectedBasePoints !== original.basePoints',
    );
  });

  it('decides WHETHER from the grant outcome, and only for `awarded`', () => {
    // Only the grant can distinguish `disabled_zero` from `capped`; the ledger
    // cannot, because both wrote nothing and both leave the same absence.
    expect(source).toContain("grant.outcome !== 'awarded'");
  });
});

describe('the honest zero, in the reversal direction', () => {
  const source = codeOf('referral-reversal.service.ts');

  it('does not call the ledger at all for a side with nothing to reverse', () => {
    // A zero-value negative row would occupy the reversal slot permanently and
    // silently deduplicate away the clawback of a figure the business approves
    // later. The early return is what keeps the slot free.
    const sideFn = source.slice(source.indexOf('private async reverseSide'));
    const guardIndex = sideFn.indexOf("grant.outcome !== 'awarded'");
    const callIndex = sideFn.indexOf('this.loyalty.reverse');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(guardIndex);
  });

  it('still records a reversal ROW for that side', () => {
    // `V32-DEC-016`'s argument for writing a `disabled_zero` grant, applied
    // here: a row saying the platform considered this side and found nothing to
    // take back is a materially different claim from no row at all.
    expect(source).toContain("outcome: 'nothing_to_reverse'");
    expect(source).toContain('recordReversal');
  });

  it('is enforced by the database, not only by the service', () => {
    const migration = migrationOf('20260901700004_create_referral_reversal.sql');
    expect(migration).toContain("(outcome = 'reversed'           AND points > 0)");
    expect(migration).toContain("(outcome = 'nothing_to_reverse' AND points = 0)");
  });
});

describe('the reversal does not touch what it must not', () => {
  const source = codeOf('referral-reversal.service.ts');

  it('never writes the monthly cap counter', () => {
    // ADR-038 §12: whether a reversal returns the referrer's cap slot is an
    // OPEN owner question that ADR-037 left open in as many words. This story
    // takes the null action rather than quietly choosing the stricter reading.
    expect(source).not.toContain('referrer_counters');
    expect(source).not.toContain('ReferralReferrerCounterEntity');
  });

  it('never recomputes a tier or touches membership', () => {
    expect(source).not.toMatch(/tier|membership/i);
  });

  it('never mutates or deletes a loyalty row', () => {
    // The ledger stays append-only: the clawback is a NEW row and the original
    // positive one is never touched (`V32-DEC-017`).
    expect(source).not.toMatch(/\b(DELETE FROM|UPDATE)\s+loyalty\./i);
    expect(source).not.toMatch(/points_entries/i);
  });

  it('has no public, administrative or manual reversal entry point', () => {
    // `V32-DEC-019` refuses a review queue, an appeal workflow, and an override
    // route; a reversal endpoint would be all three at once.
    expect(source).not.toMatch(/@(Get|Post|Put|Patch|Delete|Controller)\b/);
    expect(codeOf('referral.controller.ts')).not.toMatch(/revers/i);
  });

  it('is not triggered by a booking cancellation', () => {
    // `LEGAL_TRANSITIONS` maps `completed` to an empty set, so a qualifying
    // booking can never be cancelled -- a cancellation trigger would be an
    // unreachable branch no test could honestly cover.
    expect(source).not.toMatch(/BookingCancelled|cancel/i);
  });
});

describe('the ReferralReversed v1 contract', () => {
  const registered = ALL_EVENT_CONTRACTS.find((c) => c.name === 'ReferralReversed');

  it('is registered exactly once, produced by referral, at version 1', () => {
    expect(ALL_EVENT_CONTRACTS.filter((c) => c.name === 'ReferralReversed')).toHaveLength(1);
    expect(registered).toBeDefined();
    expect(registered!.producer).toBe('referral');
    expect(registered!.version).toBe(1);
    expect(registered!.aggregateType).toBe('referral');
  });

  const VALID_PAYLOAD = {
    referralId: '00000000-0000-4000-8000-000000000001',
    referrerUserId: '00000000-0000-4000-8000-000000000002',
    refereeUserId: '00000000-0000-4000-8000-000000000003',
    reversalOrderId: '00000000-0000-4000-8000-000000000004',
    reversedAt: '2026-09-01T00:00:00.000Z',
    referrerOutcome: 'nothing_to_reverse',
    referrerPointsReversed: 0,
    refereeOutcome: 'nothing_to_reverse',
    refereePointsReversed: 0,
  } as const;

  it('accepts the shape the service actually emits', () => {
    expect(() => ReferralReversed.schema.parse(VALID_PAYLOAD)).not.toThrow();
  });

  it('declares exactly the nine fields ADR-038 §9 freezes, and no tenth', () => {
    const shape = (ReferralReversed.schema as z.ZodObject<z.ZodRawShape>).shape;
    expect(Object.keys(shape).sort()).toEqual(Object.keys(VALID_PAYLOAD).sort());
  });

  /**
   * Which fields would accept prose, asked BEHAVIOURALLY.
   *
   * The same helper `referral-qualification.spec.ts` carries, and its reasoning
   * transfers unchanged: a structural walker reading `_def.typeName` silently
   * becomes a test of the walker when zod renames its internals — which already
   * happened once, at zod v4. And this asks the question that actually matters:
   * not "how is this field built" but "could a referral code, a phone number,
   * or a display name travel in it".
   */
  function proseAcceptingFields(schema: z.ZodTypeAny, valid: Record<string, unknown>): string[] {
    const PROSE = 'a referral code A1B2C3D4E5 or a name or any other prose';
    return Object.keys(valid).filter((field) => schema.safeParse({ ...valid, [field]: PROSE }).success);
  }

  it('has NO field that would accept a code, a name, or any other prose', () => {
    // `V32-DEC-033`: no referral code, phone, display name, or free prose in
    // any event payload. This is the structural enforcement -- every field is a
    // uuid, an instant, a bounded integer, or a member of a closed enum, so
    // there is no field a string could travel through.
    expect(proseAcceptingFields(ReferralReversed.schema as z.ZodTypeAny, VALID_PAYLOAD)).toEqual([]);
  });

  it('is NON-VACUOUS: the same audit CATCHES a planted prose field', () => {
    // The negative control that gives the case above its meaning. Without it an
    // empty result could mean "the schema is clean" or "the probe cannot detect
    // anything", and those look identical.
    const planted = z.object({
      referralId: z.string().uuid(),
      // Exactly what a well-meaning future author would add to explain a
      // clawback to a consumer.
      reversalReason: z.string(),
    });
    const plantedValid = { referralId: VALID_PAYLOAD.referralId, reversalReason: 'order fully refunded' };

    expect(proseAcceptingFields(planted, plantedValid)).toEqual(['reversalReason']);
  });

  it('refuses a NEGATIVE points value on either side', () => {
    // The mirror of the bound on `ReferralQualified`. There, `nonnegative()`
    // stops a clawback being smuggled through a reward event; here it stops a
    // REWARD being smuggled through a reversal one. The direction belongs to
    // the event's name and the ledger row's reason.
    for (const field of ['referrerPointsReversed', 'refereePointsReversed'] as const) {
      expect(ReferralReversed.schema.safeParse({ ...VALID_PAYLOAD, [field]: -50 }).success).toBe(false);
    }
  });

  it('refuses an outcome outside the closed set', () => {
    expect(
      ReferralReversed.schema.safeParse({ ...VALID_PAYLOAD, referrerOutcome: 'partially_reversed' }).success,
    ).toBe(false);
  });

  it('refuses a payload carrying a code, a phone, or a reason', () => {
    for (const extra of [
      { referralCode: 'ABCDEFGHJK' },
      { phone: '+989120000000' },
      { reason: 'پرداخت تکراری' },
      { refundAmountToman: 100000 },
    ]) {
      // `strict()` is what makes an unknown key a failure rather than a silent
      // pass-through: the base schema strips them, which would let a producer
      // put prose on the wire and every consumer receive it.
      expect(
        (ReferralReversed.schema as z.ZodObject<z.ZodRawShape>)
          .strict()
          .safeParse({ ...VALID_PAYLOAD, ...extra }).success,
      ).toBe(false);
    }
  });

  it('carries the ORDER id and no other order metadata', () => {
    const shape = (ReferralReversed.schema as z.ZodObject<z.ZodRawShape>).shape;
    expect(Object.keys(shape)).toContain('reversalOrderId');
    // No amount, no currency, no seller, no customer, and no refund id -- the
    // last because the convergence path holds no refund event (ADR-038 §4).
    for (const forbidden of ['refundId', 'amountToman', 'currency', 'sellerPartyId', 'customerId']) {
      expect(Object.keys(shape)).not.toContain(forbidden);
    }
  });
});

describe('the order-lookup port', () => {
  const port = codeOf('ports', 'referral-order-lookup.port.ts');

  it('reports four facts and no identity', () => {
    const facts = port.slice(port.indexOf('interface ReferralOrderFacts'), port.indexOf('interface ReferralOrderLookupPort'));
    expect(facts).toContain('orderId');
    expect(facts).toContain('sourceType');
    expect(facts).toContain('sourceId');
    expect(facts).toContain('fullyRefunded');
    // Money detail and identities have no business in a referral handler, and
    // there is no method here that could return them.
    for (const forbidden of ['customerId', 'sellerParty', 'Toman', 'currency', 'status']) {
      expect(facts).not.toContain(forbidden);
    }
  });

  it('reports a BOOLEAN for full refund, not the order status string', () => {
    // The referral domain has no business knowing that `partially_refunded`,
    // `cancelled` and `paid` are different things: it asks one question and the
    // mapping lives in the module that owns order statuses.
    expect(port).toContain('readonly fullyRefunded: boolean');
  });

  it('takes the caller EntityManager on every method', () => {
    const methods = port.match(/^\s{2}find\w+\([^)]*\)/gms) ?? [];
    expect(methods.length).toBe(2);
    for (const method of methods) expect(method).toContain('manager: EntityManager');
  });

  it('has NO duplicate-charge field, because the exclusion is structural', () => {
    // A duplicate charge never reaches `recordRefund`, so it never moves an
    // order's status and `fullyRefunded` is already false for it, permanently.
    // A field reporting it would be a guard that can never fire -- which reads,
    // to the next author, as though the danger were being handled somewhere.
    const facts = port.slice(port.indexOf('interface ReferralOrderFacts'), port.indexOf('interface ReferralOrderLookupPort'));
    expect(facts).not.toMatch(/duplicate/i);
  });
});

describe('the migration', () => {
  const migration = migrationOf('20260901700004_create_referral_reversal.sql');

  it('is a NEW forward migration and edits no merged one', () => {
    // The two already-merged referral migrations are untouched: this file adds
    // the reversed state by ALTERing, and replaces the trigger FUNCTION rather
    // than dropping the trigger.
    expect(migration).toContain('ALTER TABLE referral.referrals');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION referral.reject_attribution_rewrite');
    expect(migration).not.toContain('DROP TRIGGER');
    expect(migration).not.toContain('DROP TABLE');
    expect(migration).not.toMatch(/DELETE FROM|TRUNCATE/i);
  });

  it('touches NO loyalty, financial, role or grant object', () => {
    // The points ledger is owned by `beauclick_app` and already carries a
    // SIGNED `points` column with no CHECK on `reason`, so the clawback needs
    // no loyalty schema change at all. `financial.ledger_entries` is a
    // different object owned by a different role, and referral reaches neither
    // directly (ADR-038 §13).
    const code = migrationCodeOf('20260901700004_create_referral_reversal.sql');
    expect(code).not.toMatch(/\bloyalty\./i);
    expect(code).not.toMatch(/\bfinancial\./i);
    expect(code).not.toMatch(/^\s*(GRANT|REVOKE|CREATE ROLE|ALTER ROLE)/im);

    // Non-vacuity: the stripper must not have removed the whole file.
    expect(code).toContain('CREATE TABLE referral.reward_reversals');
  });

  it('keeps the qualification facts on a reversed row', () => {
    // `V32-DEC-017` reverses the REWARD, never the record that it was earned --
    // and losing the booking id would destroy the link back to the order that
    // caused the reversal, on the row whose job is now to explain it.
    expect(migration).toContain("status IN ('qualified', 'reversed')");
  });

  it('makes torn reversal facts unwritable in BOTH directions', () => {
    expect(migration).toContain("(status = 'reversed'  AND reversed_at IS NOT NULL AND reversal_order_id IS NOT NULL)");
    expect(migration).toContain("(status <> 'reversed' AND reversed_at IS NULL     AND reversal_order_id IS NULL)");
  });

  it('makes the lifecycle a one-way street with an ALLOW-list', () => {
    // Written as an allow-list rather than a list of refusals, so a FOURTH
    // status added later is refused by default rather than silently permitted
    // from and to everywhere.
    expect(migration).toContain("(OLD.status = 'pending'   AND NEW.status = 'qualified')");
    expect(migration).toContain("(OLD.status = 'qualified' AND NEW.status = 'reversed')");
  });

  it('keeps the two rules the replaced trigger already enforced', () => {
    // A `CREATE OR REPLACE` that dropped a branch would pass every new test and
    // silently unfreeze the attribution.
    expect(migration).toContain('attribution is immutable');
    expect(migration).toContain('qualification is immutable once recorded');
    expect(migration).toContain('reversal is immutable once recorded');
  });

  it('indexes the reversal handler access path', () => {
    // Without it, the lookup is a sequential scan of every referral the
    // platform has ever qualified, on every full refund of every order.
    expect(migration).toContain('CREATE INDEX ix_referrals_qualified_booking');
    expect(migration).toContain("WHERE status = 'qualified'");
  });
});

describe('the subject-data claim', () => {
  const contract = codeOf('referral-subject-data.contract.ts');

  it('claims the new table, as RETAINED, with a reason', () => {
    expect(contract).toContain("table: 'referral.reward_reversals'");
    // The retained disposition is the one that EXCUSES a table from erasure, so
    // it is the one that must justify itself.
    const claim = contract.slice(contract.indexOf("table: 'referral.reward_reversals'"));
    expect(claim.slice(0, 400)).toContain("disposition: 'retained'");
    expect(claim.slice(0, 400)).toContain('reason:');
  });

  it('names the recipient column with the ADR-027 `_user_id` suffix', () => {
    // So a `no_subject_data` claim on this table would be rejected at boot on
    // the strength of the column name alone -- the belt under the braces of the
    // declared disposition.
    expect(migrationOf('20260901700004_create_referral_reversal.sql')).toContain('recipient_user_id UUID NOT NULL');
  });

  it("exports the subject's own reversals and never a counterparty id", () => {
    const section = contract.slice(contract.indexOf("key: 'referral_reward_reversals'"));
    const rows = section.slice(section.indexOf('rows:'), section.indexOf('},', section.indexOf('rows:')));
    // Built field by field rather than spread: a spread would carry the
    // referral id and would silently carry any column a later migration adds.
    expect(rows).toContain('side:');
    expect(rows).toContain('outcome:');
    expect(rows).toContain('points:');
    expect(rows).toContain('reversedAt:');
    expect(rows).not.toContain('referralId');
    expect(rows).not.toMatch(/referrerUserId|refereeUserId|orderId/);
  });
});

describe('the notification templates', () => {
  const registry = readFileSync(
    join(__dirname, '..', '..', 'notification', 'src', 'templates', 'template.registry.ts'),
    'utf8',
  );

  it('exist for both sides, under the opt-outable referral category', () => {
    for (const key of ['referral_reversed_referrer', 'referral_reversed_referee']) {
      const block = registry.slice(registry.indexOf(`key: '${key}'`));
      expect(block.slice(0, 300)).toContain("category: 'referral'");
      expect(block.slice(0, 300)).toContain('requiredVars: []');
    }
  });

  it('take NO variables at all', () => {
    // There is no slot a points figure, a name, a code, or an order id could
    // travel through even if a later author wanted one -- and with both
    // configured values at 0, a message stating an amount would be false.
    for (const key of ['referral_reversed_referrer', 'referral_reversed_referee']) {
      const block = registry.slice(registry.indexOf(`key: '${key}'`));
      const template = block.slice(0, block.indexOf('},'));
      expect(template).not.toMatch(/\{[a-zA-Z]/);
    }
  });

  it('name no counterparty and no amount', () => {
    for (const key of ['referral_reversed_referrer', 'referral_reversed_referee']) {
      const block = registry.slice(registry.indexOf(`key: '${key}'`));
      const template = block.slice(0, block.indexOf('},'));
      expect(template).not.toMatch(/امتیاز|تومان|کد/);
    }
  });

  it('deep-link to the subject own referral page, never to an order or an id', () => {
    for (const key of ['referral_reversed_referrer', 'referral_reversed_referee']) {
      const block = registry.slice(registry.indexOf(`key: '${key}'`));
      expect(block.slice(0, block.indexOf('},'))).toContain("deepLink: '/referral'");
    }
  });
});

describe('every side is decided independently', () => {
  const source = codeOf('referral-reversal.service.ts');

  it('processes both sides, always both, referrer first', () => {
    expect(source).toContain("const SIDES: readonly ReferralRewardSide[] = ['referrer', 'referee']");
    expect([...REFERRAL_REWARD_SIDES]).toEqual(['referrer', 'referee']);
  });

  it('never skips one side because of the other', () => {
    // `V32-DEC-019`'s owner correction, carried through to the reversal: an
    // invited customer must never lose their own outcome to somebody else's
    // activity, in either direction.
    const loop = source.slice(source.indexOf('for (const side of SIDES)'));
    const body = loop.slice(0, loop.indexOf('\n    }'));
    expect(body).not.toMatch(/\b(break|continue|return)\b/);
  });
});
