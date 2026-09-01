import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  ALL_EVENT_CONTRACTS,
  REFERRAL_REWARD_OUTCOMES,
  REFERRAL_REWARD_SIDES,
  ReferralQualified,
} from '@beauclick/event-contracts';

import { isJalaliLeapYear, jalaliMonthLength } from '@beauclick/persian-utils';

import { REFERRAL_PERIOD_KEY_PATTERN, tehranCalendarMonth } from './referral-clock';
import { REFERRAL_REWARD_DEFAULTS } from './referral-reward.config';
import { REFERRAL_LEDGER_REFERENCE_TYPE, REFERRAL_MONTHLY_CAP } from './referral-qualification.service';
import { REFERRAL_STATUSES } from './entities/referral.entities';

const sourceOf = (...segments: string[]) => readFileSync(join(__dirname, ...segments), 'utf8');

/**
 * The source with comments removed.
 *
 * Several assertions below forbid an identifier from appearing in a file, and
 * a raw source match cannot tell a REFERENCE from an EXPLANATION of why there
 * is no reference. This codebase documents its absences at length --
 * deliberately -- so three of these cases failed on their own docblocks the
 * first time they ran: the cap comment says `ConfigService`, the port docblock
 * says `balance`, and the counter comment says `raw.length`, each while
 * explaining precisely why the thing is NOT used.
 *
 * Stripping comments aims the rule at code, which is what it always meant.
 * `referral-attribution.spec.ts` carries the same helper for the same reason.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const codeOf = (...segments: string[]) => stripComments(sourceOf(...segments));

/**
 * The parts of Story #12 that are arithmetic, vocabulary, or structure
 * (ADR-037).
 *
 * Everything that needs a real database — the compare-and-swap, the cap race,
 * the ledger idempotency, the transaction boundary — lives in
 * `apps/api/test/referral-qualification.pg-spec.ts` and cannot honestly be
 * proved here: pg-mem has no `ON CONFLICT … WHERE`, no triggers, and does not
 * honour `ROLLBACK`.
 */

describe('the reward configuration', () => {
  it('has TWO independent values, and both production defaults are ZERO', () => {
    // `V32-DEC-016` decided (c) both sides with independent values. The two
    // being separate keys is the decision; the two being 0 is its current
    // answer.
    expect(REFERRAL_REWARD_DEFAULTS.referrerPoints).toBe(0);
    expect(REFERRAL_REWARD_DEFAULTS.refereePoints).toBe(0);

    // Two distinct properties, not one aliased twice. A single shared value
    // would quietly re-merge a decision the owner explicitly split -- and would
    // make the two ledger reasons pointless, since their whole purpose is that
    // the sides are separately payable.
    expect(Object.keys(REFERRAL_REWARD_DEFAULTS).sort()).toEqual(['refereePoints', 'referrerPoints']);
  });

  it('does not reuse V2\'s 50, or any other inherited figure', () => {
    // Named explicitly because it is the exact number a future author would
    // find in V2 and assume was approved. `V32-DEC-016` set both to 0, and a
    // roadmap example, a legacy implementation, a comment, a seed, or a test
    // fixture is not owner approval for a non-zero production reward.
    for (const value of Object.values(REFERRAL_REWARD_DEFAULTS)) {
      expect(value).not.toBe(50);
      expect(value).toBe(0);
    }
  });

  it('is validated at startup rather than silently falling back', () => {
    // The three GAP-10 flat awards fall back on a malformed value, which is
    // right for a placeholder. These two refuse to boot, because a malformed
    // value would silently become 0 -- and 0 is a DECIDED value here, so the
    // misconfiguration would be indistinguishable from a correct deployment
    // that had deliberately disabled rewards.
    const validation = sourceOf('..', '..', '..', 'apps', 'api', 'src', 'config', 'env.validation.ts');

    expect(validation).toMatch(/checkReferralRewardValues/);
    expect(validation).toMatch(/LOYALTY_POINTS_REFERRAL_REFERRER/);
    expect(validation).toMatch(/LOYALTY_POINTS_REFERRAL_REFEREE/);
    // Called unconditionally, NOT inside the production-only branch.
    expect(validation).toMatch(/checkReferralRewardValues\(config, errors\);\r?\n\r?\n?\s*if \(nodeEnv === 'production'\)/);
  });
});

describe('the reward vocabularies', () => {
  it('are closed sets with exactly the members ADR-037 freezes', () => {
    expect([...REFERRAL_REWARD_SIDES]).toEqual(['referrer', 'referee']);
    expect([...REFERRAL_REWARD_OUTCOMES]).toEqual(['awarded', 'disabled_zero', 'capped']);
  });

  it('carries no free-form or open-ended member', () => {
    // No `failed`, `pending`, `unknown`, or `other`. Each would be a state the
    // transaction cannot produce: the qualification either commits whole or
    // does not exist (ADR-037 §5).
    for (const outcome of REFERRAL_REWARD_OUTCOMES) {
      expect(outcome).not.toMatch(/fail|pending|unknown|other|error|partial/i);
    }
  });

  it('has exactly two referral statuses, and neither is expired or reversed', () => {
    expect([...REFERRAL_STATUSES]).toEqual(['pending', 'qualified']);
    // `expired` is a PREDICATE (`expires_at <= now()`), not a state -- storing
    // it would need a sweeper and make expiry depend on whether a job ran.
    // `reversed` is Story #28's vocabulary.
    for (const status of REFERRAL_STATUSES) {
      expect(status).not.toMatch(/expir|revers|clawback|refund/i);
    }
  });
});

describe('the ledger reasons and the reference', () => {
  const qualification = codeOf('referral-qualification.service.ts');

  it('uses TWO distinct reasons, exactly as V32-DEC-016 names them', () => {
    // The whole reason two exist: the ledger's idempotency is
    // UNIQUE(reference_type, reference_id, reason), so ONE reason would make
    // the two people's rewards for one referral id collide in the same slot --
    // the second would silently never happen.
    expect(qualification).toMatch(/referrer: 'referral_referrer_reward'/);
    expect(qualification).toMatch(/referee: 'referral_referee_reward'/);
  });

  it('references the REFERRAL id, never the booking id', () => {
    expect(REFERRAL_LEDGER_REFERENCE_TYPE).toBe('referral');

    // The guarantee is one reward per REFERRAL per side. Referencing the
    // booking would express one reward per BOOKING per side, which is a
    // different and weaker statement the moment a referee books twice.
    expect(qualification).toMatch(/referenceId: referralId/);
    expect(qualification).not.toMatch(/referenceId:\s*\w*[Bb]ooking/);
  });

  it('reads the affected-row count through returningRows, never result.length', () => {
    // `sql-result.ts` exists because this exact mistake shipped twice -- one of
    // them let a REVOKED refresh token mint a session. Issue #12 names the trap
    // by name.
    expect(qualification).toMatch(/returningRows/);
    expect(qualification).not.toMatch(/raw\.length|result\.length/);
  });
});

describe('the monthly cap', () => {
  it('is 10, per V32-DEC-019, and is not an environment variable', () => {
    expect(REFERRAL_MONTHLY_CAP).toBe(10);

    // The reward VALUES are configuration because V32-DEC-016 expects the
    // business to set them. The CAP is an abuse control the same decision fixes
    // at a number, so making it configurable would let a deployment quietly
    // widen a bound an owner decision closed.
    const qualification = codeOf('referral-qualification.service.ts');

    // A literal, not a lookup. Written as an exact match rather than a
    // "not-configurable" pattern: the first attempt was
    // `/REFERRAL_MONTHLY_CAP\s*=\s*[^1]/`, which backtracked -- `\s*` matched
    // empty so `[^1]` matched the space -- and failed against a perfectly
    // correct `= 10`. A negative regex that can match by backtracking is a
    // worse guard than a positive one that says what it wants.
    expect(qualification).toMatch(/export const REFERRAL_MONTHLY_CAP = 10;/);
    // And nothing in this file reads the environment.
    expect(qualification).not.toMatch(/process\.env|ConfigService|this\.config/);
  });

  it('charges with ONE conditional statement, never a read-then-write', () => {
    const qualification = codeOf('referral-qualification.service.ts');

    expect(qualification).toMatch(/ON CONFLICT \(referrer_user_id, period\) DO UPDATE/);
    expect(qualification).toMatch(/WHERE referral\.referrer_counters\.qualified_count < \$3/);
    expect(qualification).toMatch(/RETURNING qualified_count/);
    // `V32-DEC-019` calls a read-then-write cap GAP-04 reproduced knowingly.
    expect(qualification).not.toMatch(/SELECT\s+.*qualified_count.*FROM referral\.referrer_counters/i);
  });
});

describe('the Solar Hijri (Jalali) cap period — V32-DEC-035', () => {
  /**
   * Every instant below is an ACTUAL UTC INSTANT, not a formatted label.
   *
   * Tehran is UTC+03:30 and Iran abolished DST in 2022, so 00:00 Tehran is
   * **20:30 UTC on the preceding day**. That is where every boundary in this
   * group sits, and asserting it in UTC is the only way to prove the boundary
   * is the Tehran one rather than the machine's.
   *
   * Nothing here reads the current date, the host timezone, or the host locale:
   * `tehranCalendarMonth` takes the instant as an argument, and the expected
   * values are literals.
   */

  it('uses the JALALI year and month, not the Gregorian ones', () => {
    // The headline. 2026-09-15 in Tehran is Shahrivar 1405 -- so a Gregorian
    // implementation returns `2026-09` and this must not.
    const instant = new Date('2026-09-15T12:00:00.000Z');

    expect(tehranCalendarMonth(instant)).toBe('1405-06');
    expect(tehranCalendarMonth(instant)).not.toBe('2026-09');
    // And the Jalali year is nowhere near the Gregorian one, which is the
    // cheapest possible check that a calendar conversion happened at all.
    expect(tehranCalendarMonth(instant).slice(0, 4)).toBe('1405');
  });

  it('maps Nowruz correctly on both sides of the boundary', () => {
    // 1 Farvardin 1405 = 2026-03-21 Tehran, so the year rolls at
    // 2026-03-20T20:30:00Z. Esfand 1404 -> Farvardin 1405.
    expect(tehranCalendarMonth(new Date('2026-03-20T20:29:59.999Z'))).toBe('1404-12');
    expect(tehranCalendarMonth(new Date('2026-03-20T20:30:00.000Z'))).toBe('1405-01');
  });

  it('rolls at 00:00 Asia/Tehran, NOT 00:00 UTC', () => {
    // The instant a UTC-based implementation would treat as the boundary is
    // three and a half hours LATE -- by 00:00 UTC on 2026-03-21 the new Jalali
    // month has already been running since 20:30Z the previous day.
    expect(tehranCalendarMonth(new Date('2026-03-20T21:00:00.000Z'))).toBe('1405-01');
    expect(tehranCalendarMonth(new Date('2026-03-21T00:00:00.000Z'))).toBe('1405-01');
    // ...and the instant just before the TEHRAN boundary is still the old
    // month, even though it is the same UTC day as instants that are not.
    expect(tehranCalendarMonth(new Date('2026-03-20T20:29:00.000Z'))).toBe('1404-12');
  });

  it('keeps the last instant of a Jalali month in the previous bucket', () => {
    // 31-day month: Shahrivar 1405 ends 2026-09-22 Tehran; 1 Mehr is 09-23.
    expect(tehranCalendarMonth(new Date('2026-09-22T20:29:59.999Z'))).toBe('1405-06');
  });

  it('puts the first instant of a Jalali month in the new bucket', () => {
    expect(tehranCalendarMonth(new Date('2026-09-22T20:30:00.000Z'))).toBe('1405-07');
  });

  it('rolls a 31-day month correctly (months 1-6)', () => {
    // Farvardin 1405 has 31 days: 1405-01-01 = 2026-03-21, so 1405-02-01 is
    // 2026-04-21 and the boundary is 2026-04-20T20:30Z.
    expect(tehranCalendarMonth(new Date('2026-04-20T20:29:59.999Z'))).toBe('1405-01');
    expect(tehranCalendarMonth(new Date('2026-04-20T20:30:00.000Z'))).toBe('1405-02');
  });

  it('rolls a 30-day month correctly (months 7-11)', () => {
    // Aban 1405 has 30 days: 1405-09-01 (Azar) = 2026-11-22, boundary
    // 2026-11-21T20:30Z.
    expect(tehranCalendarMonth(new Date('2026-11-21T20:29:59.999Z'))).toBe('1405-08');
    expect(tehranCalendarMonth(new Date('2026-11-21T20:30:00.000Z'))).toBe('1405-09');
  });

  it('rolls Esfand correctly in a NON-LEAP Persian year (29 days)', () => {
    // 1404 is not a leap year, so Esfand 1404 has 29 days and ends
    // 2026-03-20 Tehran.
    expect(isJalaliLeapYear(1404)).toBe(false);
    expect(jalaliMonthLength(1404, 12)).toBe(29);
    expect(tehranCalendarMonth(new Date('2026-03-20T20:29:59.999Z'))).toBe('1404-12');
    expect(tehranCalendarMonth(new Date('2026-03-20T20:30:00.000Z'))).toBe('1405-01');
  });

  it('rolls Esfand correctly in a LEAP Persian year (30 days)', () => {
    // 1403 IS a leap year, so Esfand 1403 has 30 days and 1 Farvardin 1404
    // falls on 2025-03-21 -- boundary 2025-03-20T20:30Z. A leap-year bug would
    // move this by exactly one day.
    expect(isJalaliLeapYear(1403)).toBe(true);
    expect(jalaliMonthLength(1403, 12)).toBe(30);
    expect(tehranCalendarMonth(new Date('2025-03-20T20:29:59.999Z'))).toBe('1403-12');
    expect(tehranCalendarMonth(new Date('2025-03-20T20:30:00.000Z'))).toBe('1404-01');
  });

  it('does NOT reset when the GREGORIAN month changes inside one Jalali month', () => {
    // Mehr 1405 runs 2026-09-23 .. 2026-10-22 Tehran, so it spans the
    // Gregorian September -> October boundary. A Gregorian implementation
    // resets here; the ratified one must not.
    expect(tehranCalendarMonth(new Date('2026-09-30T20:29:00.000Z'))).toBe('1405-07');
    expect(tehranCalendarMonth(new Date('2026-09-30T20:31:00.000Z'))).toBe('1405-07');
  });

  it('DOES reset when the JALALI month changes inside one Gregorian month', () => {
    // The mirror image, and together with the case above it is the pair that
    // proves the semantics actually changed. Both instants are Gregorian
    // 2026-09; only the Jalali month differs.
    expect(tehranCalendarMonth(new Date('2026-09-22T20:29:00.000Z'))).toBe('1405-06');
    expect(tehranCalendarMonth(new Date('2026-09-22T20:31:00.000Z'))).toBe('1405-07');
  });

  it('produces ASCII digits matching the database CHECK, across a whole Jalali year', () => {
    // `ck_referrer_counters_period_format` is `^[0-9]{4}-(0[1-9]|1[0-2])$`. A
    // key with Persian digits (`۱۴۰۵-۰۶`) would look right in a log and be
    // rejected at INSERT time, in production, on the first qualification of a
    // month -- so the shape is asserted, and so is the absence of non-ASCII.
    for (let month = 0; month < 12; month += 1) {
      // The 10th of each Gregorian month at noon Tehran, which walks the whole
      // Jalali year without landing on a boundary.
      const value = tehranCalendarMonth(new Date(Date.UTC(2026, month, 10, 8, 30)));

      expect(value).toMatch(REFERRAL_PERIOD_KEY_PATTERN);
      expect(value).toMatch(/^[\x20-\x7E]+$/);
      expect(value).not.toMatch(/[۰-۹٠-٩]/);
    }
  });

  it('pins the application pattern to the database CHECK', () => {
    // The two are deliberately duplicated -- the database constraint is the
    // real guarantee and the application one exists to fail diagnosably a
    // statement earlier. Duplication is only safe if something asserts they
    // agree, and the migration is read from disk rather than transcribed.
    const migration = readFileSync(
      join(
        __dirname,
        '..', '..', '..',
        'database', 'migrations', 'referral',
        '20260901700003_create_referral_qualification.sql',
      ),
      'utf8',
    );

    expect(migration).toContain("period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'");
    expect(REFERRAL_PERIOD_KEY_PATTERN.source).toBe('^[0-9]{4}-(0[1-9]|1[0-2])$');
  });

  it('fails CLOSED on a malformed conversion rather than writing a bad key', () => {
    // A period key is the bucket a payout limit is counted in. A silently wrong
    // one creates a parallel window nothing ever caps, so the helper throws
    // rather than returning something that merely looks plausible.
    //
    // Driven by making the CALENDAR return an impossible month, which is the
    // only realistic failure mode: `wallClockIn` cannot produce a non-numeric
    // year, but a future calendar-library swap could return `jm = 13`.
    //
    // `jest.doMock` inside `isolateModules` rather than `spyOn`, because an ES
    // module's exports are non-configurable and `spyOn` throws
    // "Cannot redefine property". Isolating the registry also keeps the fake
    // calendar from leaking into any other case in this file.
    jest.isolateModules(() => {
      jest.doMock('@beauclick/persian-utils', () => ({
        ...jest.requireActual('@beauclick/persian-utils'),
        toJalali: () => ({ jy: 1405, jm: 13, jd: 1 }),
      }));

      // `require` rather than `import`, because `jest.isolateModules` needs a
      // SYNCHRONOUS load to pick up the mocked registry -- a static import is
      // hoisted above `doMock` and would get the real module. The rule is
      // suppressed by name for this one line rather than the file.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const withBrokenCalendar = require('./referral-clock') as typeof import('./referral-clock');

      expect(() => withBrokenCalendar.tehranCalendarMonth(new Date('2026-09-15T12:00:00.000Z'))).toThrow(
        /malformed/i,
      );
    });

    jest.dontMock('@beauclick/persian-utils');

    // Non-vacuity: the real implementation still works, so the case above
    // proved the guard rather than proving the mock broke the module.
    expect(tehranCalendarMonth(new Date('2026-09-15T12:00:00.000Z'))).toBe('1405-06');
  });

  it('is deterministic — the same instant always yields the same key', () => {
    // No hidden dependence on the current date, the host timezone, or a
    // formatter cache warming up.
    const instant = new Date('2026-09-15T12:00:00.000Z');
    const keys = new Set(Array.from({ length: 50 }, () => tehranCalendarMonth(instant)));
    expect([...keys]).toEqual(['1405-06']);
  });
});

describe('the ReferralQualified v1 contract', () => {
  const registered = ALL_EVENT_CONTRACTS.find((contract) => contract.name === 'ReferralQualified');

  it('is registered exactly once, produced by referral, at version 1', () => {
    expect(registered).toBeDefined();
    expect(ALL_EVENT_CONTRACTS.filter((c) => c.name === 'ReferralQualified')).toHaveLength(1);
    expect(registered!.producer).toBe('referral');
    expect(registered!.version).toBe(1);
    expect(registered!.aggregateType).toBe('referral');
  });

  it('is the ONLY referral event in the catalogue', () => {
    // `V32-DEC-033` approves `ReferralQualified` v1 and `ReferralReversed` v1
    // and nothing else; the second is Story #28's. `ReferralAttributed` is
    // refused outright -- no consumer.
    const referralEvents = ALL_EVENT_CONTRACTS.filter((c) => c.producer === 'referral').map((c) => c.name);
    expect(referralEvents).toEqual(['ReferralQualified']);

    for (const name of ALL_EVENT_CONTRACTS.map((c) => c.name)) {
      expect(name).not.toMatch(/ReferralAttributed|ReferralReversed|ReferralRewarded|ReferralCapped|ReferralExpired/);
    }
  });

  const VALID_PAYLOAD = {
    referralId: '00000000-0000-4000-8000-000000000001',
    referrerUserId: '00000000-0000-4000-8000-000000000002',
    refereeUserId: '00000000-0000-4000-8000-000000000003',
    qualifyingBookingId: '00000000-0000-4000-8000-000000000004',
    qualifiedAt: '2026-09-01T00:00:00.000Z',
    referrerOutcome: 'disabled_zero',
    referrerPoints: 0,
    refereeOutcome: 'disabled_zero',
    refereePoints: 0,
  } as const;

  /**
   * Every field of `schema` that would ACCEPT arbitrary prose.
   *
   * Probes the schema **behaviourally** rather than reading zod's internals:
   * for each declared field, it substitutes a string that is neither a uuid nor
   * an instant nor an enum member, and reports the fields that parse anyway.
   *
   * Behavioural rather than structural for two reasons. It survives a zod major
   * version — the first attempt read `_def.typeName`, which zod v4 renamed, so
   * a structural walker silently becomes a test of the walker rather than of
   * the schema. And it asks the question that actually matters: not "how is
   * this field built" but "could a referral code, a phone number, or a display
   * name travel in it".
   */
  function proseAcceptingFields(schema: z.ZodTypeAny, valid: Record<string, unknown>): string[] {
    const PROSE = 'a referral code A1B2C3D4E5 or a name or any other prose';
    return Object.keys(valid).filter((field) => schema.safeParse({ ...valid, [field]: PROSE }).success);
  }

  it('has NO field that would accept a code, a name, or any other prose', () => {
    // `V32-DEC-033`: no referral code, phone, display name, or free prose in
    // any event payload. This is the structural enforcement -- there is no
    // field a string could travel through.
    expect(proseAcceptingFields(registered!.schema as z.ZodTypeAny, VALID_PAYLOAD)).toEqual([]);
  });

  it('is NON-VACUOUS: the same audit CATCHES a planted prose field', () => {
    // The negative control, and it is the assertion that gives the case above
    // its meaning. Without it, an empty result could mean "the schema is clean"
    // or "the probe cannot detect anything" -- and those look identical.
    const planted = z.object({
      referralId: z.string().uuid(),
      // Exactly what a well-meaning future author would add.
      referrerDisplayName: z.string(),
    });
    const plantedValid = { referralId: VALID_PAYLOAD.referralId, referrerDisplayName: 'Someone' };

    expect(proseAcceptingFields(planted, plantedValid)).toEqual(['referrerDisplayName']);
  });

  it('declares exactly the nine fields ADR-037 §10 freezes, and no tenth', () => {
    // Complements the prose probe: that one proves no DECLARED field admits
    // prose, and this proves the declared set itself has not grown. A new uuid
    // field would pass the probe and still be a payload widening.
    const parsed = (registered!.schema as z.ZodTypeAny).parse(VALID_PAYLOAD) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual([
      'qualifiedAt',
      'qualifyingBookingId',
      'refereeOutcome',
      'refereePoints',
      'refereeUserId',
      'referralId',
      'referrerOutcome',
      'referrerPoints',
      'referrerUserId',
    ]);
  });

  it('rejects a payload carrying a code, a phone, or prose', () => {
    // The runtime half: the registry validates on emit, so an extra field is
    // not merely undeclared -- zod strips it, and the stored payload cannot
    // contain it. Asserted by parsing and checking what survives.
    const parsed = (registered!.schema as z.ZodTypeAny).parse({
      referralId: '00000000-0000-4000-8000-000000000001',
      referrerUserId: '00000000-0000-4000-8000-000000000002',
      refereeUserId: '00000000-0000-4000-8000-000000000003',
      qualifyingBookingId: '00000000-0000-4000-8000-000000000004',
      qualifiedAt: '2026-09-01T00:00:00.000Z',
      referrerOutcome: 'disabled_zero',
      referrerPoints: 0,
      refereeOutcome: 'disabled_zero',
      refereePoints: 0,
      // None of these is declared.
      referralCode: 'A1B2C3D4E5',
      phone: '+989120000000',
      note: 'some prose',
    });

    expect(parsed).not.toHaveProperty('referralCode');
    expect(parsed).not.toHaveProperty('phone');
    expect(parsed).not.toHaveProperty('note');
    expect(JSON.stringify(parsed)).not.toContain('A1B2C3D4E5');
  });

  it('refuses a negative points value', () => {
    // A reversal is a NEW NEGATIVE ROW in the loyalty ledger under a distinct
    // reason (`V32-DEC-017`), never a negative number on a qualification. A
    // schema admitting one would let Story #28's clawback be smuggled through
    // this event instead of through its own.
    const base = {
      referralId: '00000000-0000-4000-8000-000000000001',
      referrerUserId: '00000000-0000-4000-8000-000000000002',
      refereeUserId: '00000000-0000-4000-8000-000000000003',
      qualifyingBookingId: '00000000-0000-4000-8000-000000000004',
      qualifiedAt: '2026-09-01T00:00:00.000Z',
      referrerOutcome: 'awarded' as const,
      refereeOutcome: 'awarded' as const,
      refereePoints: 5,
    };

    expect(() => ReferralQualified.schema.parse({ ...base, referrerPoints: -1 })).toThrow();
    expect(() => ReferralQualified.schema.parse({ ...base, referrerPoints: 1.5 })).toThrow();
    expect(() => ReferralQualified.schema.parse({ ...base, referrerPoints: 5 })).not.toThrow();
  });

  it('refuses an outcome outside the closed set', () => {
    expect(() =>
      ReferralQualified.schema.parse({
        referralId: '00000000-0000-4000-8000-000000000001',
        referrerUserId: '00000000-0000-4000-8000-000000000002',
        refereeUserId: '00000000-0000-4000-8000-000000000003',
        qualifyingBookingId: '00000000-0000-4000-8000-000000000004',
        qualifiedAt: '2026-09-01T00:00:00.000Z',
        referrerOutcome: 'reversed',
        referrerPoints: 0,
        refereeOutcome: 'disabled_zero',
        refereePoints: 0,
      }),
    ).toThrow();
  });
});

describe('the Story #28 boundary', () => {
  it('declares no reversal reason, event, or method anywhere in the module', () => {
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const file of [
      'referral-qualification.service.ts',
      'referral-reward.config.ts',
      'ports/referral-loyalty.port.ts',
      'entities/referral.entities.ts',
    ]) {
      const code = stripComments(sourceOf(...file.split('/')));
      expect(code).not.toMatch(/referral_reversal|referral_clawback|ReferralReversed|OrderRefunded/);
      expect(code).not.toMatch(/clawback|reversal/i);
    }
  });

  it('never computes a negative points value', () => {
    // The domain reads two non-negative configured values and passes them
    // through. There is no arithmetic that could produce a negative, and the
    // port types `points` non-negative -- so a clawback cannot be smuggled
    // through the reward path even by accident.
    const code = sourceOf('referral-qualification.service.ts');
    expect(code).not.toMatch(/-\s*decision\.points|points\s*\*\s*-1|-points\b/);
  });
});

describe('the port boundary', () => {
  it('takes the caller EntityManager as its first argument', () => {
    // ADR-011 and V3.2-B bug #2: a port that opens its own connection inside a
    // caller's transaction needed 2N connections against a pool of 10, and past
    // five the suite STOPPED with no error. Asserted on the declaration,
    // because an interface erases at runtime.
    const port = sourceOf('ports', 'referral-loyalty.port.ts');

    expect(port).toMatch(/award\(manager: EntityManager, input: ReferralLoyaltyAward\): Promise<\{ awarded: boolean \}>/);
    // And it may not acquire its own connection.
    expect(port).not.toMatch(/DataSource|Repository|getRepository/);
  });

  it('returns only `awarded`, never a balance or a tier', () => {
    // A balance and a lifetime total are facts about a person's WHOLE loyalty
    // history, and a referral handler holding one would be a step from putting
    // it in a payload `V32-DEC-033` forbids.
    const port = codeOf('ports', 'referral-loyalty.port.ts');
    expect(port).not.toMatch(/balance|lifetimeEarned|tierChanged|entryId/);
  });

  it('is declared with no default implementation in the module', () => {
    const module = codeOf('referral.module.ts');
    expect(module).not.toMatch(/provide:\s*REFERRAL_LOYALTY_PORT/);
    // The reward config, by contrast, IS bound -- it is a seam with a safe
    // default of zero, not a port.
    expect(module).toMatch(/provide:\s*REFERRAL_REWARD_CONFIG/);
  });
});
