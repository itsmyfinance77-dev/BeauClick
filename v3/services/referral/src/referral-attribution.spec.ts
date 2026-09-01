import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  REFERRAL_CLAIM_ATTEMPTS_PER_HOUR,
  REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS,
  REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS,
} from '@beauclick/referral-contract';

import { accountAgeCutoff, hourBucket, pendingAttributionExpiry, systemReferralClock } from './referral-clock';
import { ReferralClaimRefusedException, ReferralClaimThrottledException } from './referral.exceptions';
import { REFERRAL_BOOKING_PORT, REFERRAL_IDENTITY_PORT } from './ports/referral.ports';
import { REFERRAL_ENTITIES } from './entities/referral.entities';

const DAY_MS = 86_400_000;

/**
 * The Story #27 rules that are pure arithmetic or pure structure (ADR-036).
 *
 * Everything that needs a real database — the two constraints, the trigger, the
 * conditional throttle write, the concurrency — lives in
 * `apps/api/test/referral-attribution.pg-spec.ts` and cannot meaningfully be
 * proved here. What IS provable here is the part that is a **calculation**, and
 * a calculation deserves a test that runs in milliseconds and pins the boundary
 * to the millisecond.
 */
describe('the referral clock', () => {
  // The frozen instant every case below is computed against. A literal rather
  // than `new Date()`, so a case that accidentally depends on "now" fails
  // rather than passing for eleven months of the year.
  const now = new Date('2026-06-15T12:34:56.789Z');

  describe('the 30-day claim window', () => {
    it('is INCLUSIVE at exactly 30 days', () => {
      // Issue #27 says "account age <= 30 days". The service compares
      // `createdAt >= cutoff`, so an account created exactly at the cutoff is
      // eligible. This is the single most likely place the rule goes wrong, and
      // it would go wrong for exactly one customer per boundary.
      const cutoff = accountAgeCutoff(now, REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS);

      expect(cutoff.toISOString()).toBe('2026-05-16T12:34:56.789Z');
      expect(now.getTime() - cutoff.getTime()).toBe(30 * DAY_MS);

      // Exactly on the boundary: eligible.
      expect(cutoff.getTime() >= cutoff.getTime()).toBe(true);
      // One millisecond older: not.
      expect(cutoff.getTime() - 1 >= cutoff.getTime()).toBe(false);
    });

    it('is an absolute duration, not a calendar subtraction', () => {
      // `setUTCDate(-30)` would make the window's length depend on the month it
      // started in. Proved across February in a leap year, where a calendar
      // implementation and an arithmetic one disagree.
      const march = new Date('2028-03-20T00:00:00.000Z');
      const cutoff = accountAgeCutoff(march, REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS);

      expect(march.getTime() - cutoff.getTime()).toBe(30 * DAY_MS);
      expect(cutoff.toISOString()).toBe('2028-02-19T00:00:00.000Z');
    });

    it('carries no timezone — the same instant gives the same cutoff', () => {
      // `V32-DEC-019`'s referrer cap IS per Tehran calendar month and belongs to
      // Story #12. Nothing here may acquire a calendar, and the check is that
      // the result depends only on the instant.
      const cutoff = accountAgeCutoff(new Date(now.getTime()), REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS);
      expect(cutoff.getTime()).toBe(accountAgeCutoff(now, REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS).getTime());
    });
  });

  describe('the 90-day pending expiry', () => {
    it('is exactly 90 days after the attribution instant', () => {
      const expiry = pendingAttributionExpiry(now, REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS);

      expect(expiry.getTime() - now.getTime()).toBe(90 * DAY_MS);
      expect(expiry.toISOString()).toBe('2026-09-13T12:34:56.789Z');
    });

    it('is an absolute duration, not three calendar months', () => {
      // The distinction `V32-DEC-017` requires. Three calendar months from
      // 1 December 2027 is 1 March 2028; ninety DAYS is 29 February, because
      // 2028 is a leap year. A `setUTCMonth(+3)` implementation passes every
      // same-length-month case and fails only here.
      const december = new Date('2027-12-01T00:00:00.000Z');
      expect(pendingAttributionExpiry(december, REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS).toISOString()).toBe(
        '2028-02-29T00:00:00.000Z',
      );
    });

    it('preserves the sub-second component, so the two columns relate exactly', () => {
      // The row's `attributed_at` and `expires_at` are written from ONE clock
      // reading. If this truncated, the stored gap would not be 90 days and the
      // pg-spec's millisecond assertion would be the only thing to notice.
      expect(pendingAttributionExpiry(now, REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS).getUTCMilliseconds()).toBe(789);
    });
  });

  describe('the hourly throttle bucket', () => {
    it('truncates to the start of the UTC hour', () => {
      expect(hourBucket(now).toISOString()).toBe('2026-06-15T12:00:00.000Z');
      expect(hourBucket(new Date('2026-06-15T12:59:59.999Z')).toISOString()).toBe('2026-06-15T12:00:00.000Z');
      expect(hourBucket(new Date('2026-06-15T13:00:00.000Z')).toISOString()).toBe('2026-06-15T13:00:00.000Z');
    });

    it('does not mutate its argument', () => {
      // `setUTCMinutes` mutates, so the implementation has to copy first. A
      // version that did not would silently move the caller's `now` -- and the
      // caller is `claim`, whose very next act is to write `attributed_at`.
      const instant = new Date(now.getTime());
      hourBucket(instant);
      expect(instant.toISOString()).toBe(now.toISOString());
    });
  });

  it('the system clock returns a real, moving instant', () => {
    // Trivial, and it is the only thing standing between the module and a clock
    // that returns a constant.
    const before = Date.now();
    const reading = systemReferralClock.now().getTime();
    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(Date.now());
  });
});

describe('the claim refusals', () => {
  it('the eligibility refusal takes NO constructor arguments', () => {
    // The mechanism behind the indistinguishable response (ADR-036 §8), asserted
    // structurally rather than by comparing bodies -- which the pg-spec does
    // from the outside. A constructor that cannot express a difference cannot
    // leak one, and this is the assertion that fails the moment somebody adds a
    // `reason` parameter "just for logging".
    expect(ReferralClaimRefusedException.length).toBe(0);

    const first = new ReferralClaimRefusedException();
    const second = new ReferralClaimRefusedException();

    expect(first.getStatus()).toBe(409);
    expect(first.getResponse()).toEqual(second.getResponse());
    // No `details` at all -- not an empty object, which would serialise as a key.
    expect((first.getResponse() as { details?: unknown }).details).toBeUndefined();
  });

  it('the eligibility refusal names no cause and no party', () => {
    const serialised = JSON.stringify(new ReferralClaimRefusedException().getResponse());

    for (const cause of [
      'unknown',
      'revoked',
      'own',
      'self',
      'attributed',
      'old',
      'booked',
      'exists',
      'owner',
      'referrer',
      'referee',
      'reason',
    ]) {
      expect(serialised.toLowerCase()).not.toContain(cause);
    }
  });

  it('the THROTTLE refusal is a different, non-colliding answer', () => {
    // Deliberately NOT collapsed into the refusal above (ADR-036 §6c):
    // `V32-DEC-019` enumerates six cases and exhaustion is not among them, and
    // it reveals only how many requests the caller themselves made.
    const throttled = new ReferralClaimThrottledException();

    expect(throttled.getStatus()).toBe(429);
    expect(throttled.code).not.toBe(new ReferralClaimRefusedException().code);
    expect(throttled.details).toEqual({ attemptsPerHour: REFERRAL_CLAIM_ATTEMPTS_PER_HOUR });
  });

  it('the throttle refusal discloses no counter state', () => {
    // The published limit is fine -- the contract exports it. A remaining count
    // or a window boundary would let a caller measure the counter, and the
    // boundary would disclose when within the hour their first attempt landed.
    const serialised = JSON.stringify(new ReferralClaimThrottledException().getResponse());
    expect(serialised).not.toMatch(/retryAfter|remaining|attemptCount|window|resetAt|until/i);
  });
});

describe('the module boundary', () => {
  const sourceOf = (...segments: string[]) => readFileSync(join(__dirname, ...segments), 'utf8');

  /**
   * The source with block and line comments removed.
   *
   * Several assertions here forbid an identifier from appearing in a file, and
   * a raw source match cannot tell a **reference** from an **explanation of why
   * there is no reference**. This codebase's docblocks explain absences at
   * length — deliberately — so as the prose grew, the blunt match started
   * failing on the very comments that document the guarantee.
   *
   * Stripping comments keeps the rule aimed at code, which is what it always
   * meant. It is a crude tokenizer rather than a parser: it does not understand
   * a `//` inside a string literal, which is acceptable because every use below
   * searches for a PascalCase identifier that no string in these files
   * contains. The three assertions in the case below prove the stripper works
   * in both directions rather than trusting it.
   */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const codeOf = (...segments: string[]) => stripComments(sourceOf(...segments));

  it('declares both ports as symbols with no default implementation', () => {
    expect(typeof REFERRAL_IDENTITY_PORT).toBe('symbol');
    expect(typeof REFERRAL_BOOKING_PORT).toBe('symbol');

    // The module must NOT provide either. A default would be a permissive stub
    // that passes every test written against this module alone while disabling
    // two of the six eligibility rules in production (ADR-036 §4).
    const module = sourceOf('referral.module.ts');
    expect(module).not.toMatch(/provide:\s*REFERRAL_IDENTITY_PORT/);
    expect(module).not.toMatch(/provide:\s*REFERRAL_BOOKING_PORT/);
    // The clock, by contrast, IS bound here -- it is a seam, not a port.
    expect(module).toMatch(/provide:\s*REFERRAL_CLOCK/);
  });

  it('both ports accept an EntityManager as their first argument', () => {
    // ADR-011 and V3.2-B bug #2: a port that opens its own connection inside a
    // caller's transaction needed 2N connections against a pool of 10, and past
    // five the suite STOPPED with no error. Asserted on the declaration, because
    // an interface erases at runtime.
    const ports = sourceOf('ports', 'referral.ports.ts');

    expect(ports).toMatch(/accountCreatedAt\(manager: EntityManager, userId: string\): Promise<Date \| null>/);
    expect(ports).toMatch(/hasCompletedBooking\(manager: EntityManager, userId: string\): Promise<boolean>/);

    // And neither may take a DataSource or a Repository, which is how a port
    // acquires its own connection.
    expect(ports).not.toMatch(/DataSource|Repository/);
  });

  it('imports no other domain, so the ADR-011 boundary is structural', () => {
    // Lint enforces this too. Asserted here as well because a lint rule can be
    // disabled with a comment and this cannot.
    for (const file of [
      'referral.service.ts',
      'referral.controller.ts',
      'referral.module.ts',
      'referral-clock.ts',
      'referral.exceptions.ts',
      'referral-subject-data.contract.ts',
    ]) {
      const source = sourceOf(file);
      expect(source).not.toMatch(/@beauclick\/(identity|booking|loyalty|provider|search|financial|commerce)/);
    }
    expect(sourceOf('ports', 'referral.ports.ts')).not.toMatch(/@beauclick\/(identity|booking)/);
  });

  it('registers every entity the module owns, and nothing speculative', () => {
    // This pinned exactly three entities until V3.2-C Story #12 added the
    // grant, the counter and the outbox. The COUNT was never the guarantee --
    // widening the array each story would keep the case green while it stopped
    // checking anything.
    //
    // What it always meant, and now says: every table the module owns is
    // registered (so subject-data coverage and the test harness's reset can
    // both see it), and NOTHING from Story #28 is registered ahead of its
    // behaviour.
    const names = REFERRAL_ENTITIES.map((entity) => entity.name).sort();

    expect(names).toEqual([
      'ReferralAttributionEntity',
      'ReferralClaimAttemptEntity',
      'ReferralCodeEntity',
      'ReferralOutboxEntity',
      'ReferralReferrerCounterEntity',
      'ReferralRewardGrantEntity',
    ]);

    for (const name of names) {
      expect(name).not.toMatch(/revers|clawback|refund|appeal|review|override/i);
    }
  });

  it('still defines and emits NO ReferralAttributed, even now that an outbox exists', () => {
    // `V32-DEC-033`, ADR-036 §10, ADR-037 §10: `ReferralAttributed` has no
    // consumer, and Story #12 USED UP the last plausible argument for defining
    // it -- qualification consumes `BookingCompleted`, not an attribution
    // event.
    //
    // The second half of this case used to assert the module had no outbox at
    // all. Story #12 gives it one, WITH its first producer, exactly as ADR-035
    // §7 and ADR-036 §10 said would be the condition for creating it. So the
    // assertion narrows to what it always meant: whatever this module emits, it
    // is not an attribution event.
    // Matched against CODE, not prose.
    //
    // A raw source match used to be enough and stopped being so in this story:
    // the entities file now explains at length WHY `ReferralAttributed` is not
    // defined, and a rule that forbade naming it would forbid the explanation
    // rather than the leak. Same failure class as the `count`/`ACCOUNT` false
    // positive the contract spec records.
    for (const file of [
      'referral.service.ts',
      'referral.module.ts',
      'entities/referral.entities.ts',
      'referral-qualification.service.ts',
    ]) {
      expect(codeOf(...file.split('/'))).not.toMatch(/ReferralAttributed|ReferralClaimed/);
    }

    // Non-vacuity: the comment stripper must actually remove comments, or every
    // assertion above passes by finding an empty string.
    expect(codeOf('referral-qualification.service.ts')).toMatch(/emitContractEvent/);
    expect(stripComments('/* ReferralAttributed */ const a = 1;')).not.toMatch(/ReferralAttributed/);
    expect(stripComments('// ReferralAttributed\nconst a = 1;')).not.toMatch(/ReferralAttributed/);
    expect(stripComments('const ReferralAttributed = 1;')).toMatch(/ReferralAttributed/);

    // And the one event that IS emitted is the only one approved for this
    // story. `ReferralReversed` is approved by `V32-DEC-033` too -- but for
    // Story #28, so emitting it here would be starting that story.
    const qualification = codeOf('referral-qualification.service.ts');
    expect(qualification).toMatch(/ReferralQualified/);
    expect(qualification).not.toMatch(/ReferralReversed|ReferralRewarded|ReferralCapped|ReferralExpired/);
  });

  it('exposes no reversal, clawback, or manual-review API', () => {
    // This refused `qualif`, `reward`, `grant` and `points` as well, until
    // V3.2-C Story #12 legitimately built all four. Narrowed to Story #28's
    // vocabulary and to the three surfaces `V32-DEC-019` refuses outright --
    // manual review, appeals, and administrator overrides.
    //
    // Checked against the SOURCE rather than the prototype so a private method
    // is caught too.
    const declarationsIn = (file: string) =>
      [...sourceOf(file).matchAll(/^\s{2}(?:private\s+|async\s+|private\s+async\s+)?(\w+)\s*\(/gm)].map(
        (match) => match[1],
      );

    const service = declarationsIn('referral.service.ts');
    const qualification = declarationsIn('referral-qualification.service.ts');

    for (const name of [...service, ...qualification]) {
      expect(name).not.toMatch(/revers|clawback|refund|appeal|review|override|negative|deduct/i);
    }

    // Non-vacuity for BOTH extractions: a regex that found nothing would pass
    // the loop above no matter what either file contained.
    expect(service).toEqual(expect.arrayContaining(['claim', 'codeFor', 'chargeClaimAttempt']));
    expect(qualification).toEqual(expect.arrayContaining(['qualify', 'chargeReferrerCap', 'recordGrant']));
  });

  it('never reads the wall clock outside the injected one', () => {
    // ADR-036 §5. `new Date()` in a rule is a rule that can only be tested by
    // waiting. `referral-clock.ts` is the ONE place it is allowed.
    for (const file of ['referral.service.ts', 'referral.controller.ts', 'referral-subject-data.contract.ts']) {
      const source = sourceOf(file);
      expect(source).not.toMatch(/new Date\(\)/);
      expect(source).not.toMatch(/Date\.now\(\)/);
    }
  });

  it('the claim DTO declares exactly one property, and does not @Matches the code', () => {
    // The regression guard for the leak the adversarial suite found: the
    // platform's ValidationException serialises class-validator's
    // ValidationError, which carries the submitted `value` -- so an @Matches
    // failure echoed a bearer credential. The shape check lives in the service
    // now, where the refusal has no payload to echo into.
    const controller = sourceOf('referral.controller.ts');
    const block = controller.slice(controller.indexOf('export class ReferralClaimDto'));
    const body = block.slice(0, block.indexOf('\n}'));

    expect(body).not.toMatch(/@Matches|@Length|@MinLength|@MaxLength/);
    expect([...body.matchAll(/^\s{2}(\w+)!?:/gm)].map((match) => match[1])).toEqual(['code']);
    // And the service does check the shape, so removing it from both would fail.
    expect(sourceOf('referral.service.ts')).toMatch(/isReferralCodeShape\(code\)/);
  });
});
