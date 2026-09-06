import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BOOKING_COLLECTION_DEPOSIT_KINDS,
  BOOKING_COLLECTION_MODES,
  BOOKING_COLLECTION_PERCENTAGE_BASES,
  BOOKING_COLLECTION_POLICY_CONTRACT_VERSION,
  BookingCollectionTermsV1,
  COMMERCIAL_POLICY_CONTRACT_VERSION,
  MAX_COLLECTION_AMOUNT_TOMAN,
  bookingCollectionAmountsV1,
  collectionBreakdownV1,
  validateBookingCollectionPolicySnapshotV1,
  validateBookingCollectionTermsV1,
  validateBookingCommercialTermsV1,
} from './index';

/**
 * The collection-only contract — V3.3 Story #83 (`#41d-1`), ADR-048 §2.
 *
 * Two things are proved here that the real-PostgreSQL suite cannot: the shape
 * of the discriminated union at compile and run time, and the exact integer
 * arithmetic at its boundaries. Everything about lifecycle, immutability and
 * non-overlap belongs to the database and is proved against a real server.
 *
 * §6 is the compatibility half: the pre-existing `BookingCommercialTermsV1`
 * family must be untouched by this story, and "untouched" is asserted rather
 * than assumed.
 */
describe('booking collection policy contract (#41d-1)', () => {
  const fullOnline: BookingCollectionTermsV1 = {
    contractVersion: 1,
    collectionMode: 'full_payment_online',
    deposit: { kind: 'none' },
  };

  const payAtVenue: BookingCollectionTermsV1 = {
    contractVersion: 1,
    collectionMode: 'pay_at_venue',
    deposit: { kind: 'none' },
  };

  const fixedDeposit = (amountToman: number): BookingCollectionTermsV1 => ({
    contractVersion: 1,
    collectionMode: 'deposit_online_balance_at_venue',
    deposit: { kind: 'fixed', amountToman },
  });

  const percentageDeposit = (
    basisPoints: number,
    percentageBase: 'service_subtotal' | 'service_total',
    minimumToman = 0,
    maximumToman: number | null = null,
  ): BookingCollectionTermsV1 => ({
    contractVersion: 1,
    collectionMode: 'deposit_online_balance_at_venue',
    deposit: { kind: 'percentage', basisPoints, percentageBase, minimumToman, maximumToman },
  });

  // =========================================================================
  // §1. The closed vocabularies
  // =========================================================================

  describe('§1 vocabulary', () => {
    it('closes the percentage base to exactly the two authoritative order amounts', () => {
      expect([...BOOKING_COLLECTION_PERCENTAGE_BASES]).toEqual(['service_subtotal', 'service_total']);
    });

    it('closes the deposit rule vocabulary and adds no fourth collection mode', () => {
      expect([...BOOKING_COLLECTION_DEPOSIT_KINDS]).toEqual(['none', 'fixed', 'percentage']);
      expect([...BOOKING_COLLECTION_MODES]).toEqual([
        'pay_at_venue',
        'deposit_online_balance_at_venue',
        'full_payment_online',
      ]);
    });

    it('publishes no default mode, base, amount, rate or bound', () => {
      // A default would be a commercial value in code (`V33-DEC-028` R2). The
      // only exported constants are a contract version and a representational
      // ceiling, and this asserts the ceiling is the shape of a guard rather
      // than of a price.
      expect(BOOKING_COLLECTION_POLICY_CONTRACT_VERSION).toBe(1);
      expect(MAX_COLLECTION_AMOUNT_TOMAN).toBe(10_000_000_000_000);
    });
  });

  // =========================================================================
  // §2. Every union shape, and every invalid cross-shape
  // =========================================================================

  describe('§2 union shapes', () => {
    it('accepts each valid mode/rule pairing', () => {
      expect(validateBookingCollectionTermsV1(payAtVenue)).toEqual([]);
      expect(validateBookingCollectionTermsV1(fullOnline)).toEqual([]);
      expect(validateBookingCollectionTermsV1(fixedDeposit(50_000))).toEqual([]);
      for (const base of BOOKING_COLLECTION_PERCENTAGE_BASES) {
        expect(validateBookingCollectionTermsV1(percentageDeposit(2_500, base))).toEqual([]);
      }
    });

    it('refuses a deposit rule outside deposit mode, in both directions', () => {
      const depositOnFullOnline = {
        ...fullOnline,
        deposit: { kind: 'fixed', amountToman: 1 },
      } as BookingCollectionTermsV1;
      expect(validateBookingCollectionTermsV1(depositOnFullOnline)).toContain(
        'a deposit rule is only valid in deposit_online_balance_at_venue mode',
      );

      const depositModeWithoutRule = {
        contractVersion: 1,
        collectionMode: 'deposit_online_balance_at_venue',
        deposit: { kind: 'none' },
      } as BookingCollectionTermsV1;
      expect(validateBookingCollectionTermsV1(depositModeWithoutRule)).toContain(
        'deposit collection mode requires a deposit rule',
      );
    });

    it('refuses an unknown deposit kind and an unknown mode', () => {
      const badKind = { ...fullOnline, deposit: { kind: 'installments' } } as unknown as BookingCollectionTermsV1;
      expect(validateBookingCollectionTermsV1(badKind)).toEqual(['deposit.kind is not a v1 deposit rule']);

      const badMode = { ...fullOnline, collectionMode: 'invoice_later' } as unknown as BookingCollectionTermsV1;
      expect(validateBookingCollectionTermsV1(badMode)).toContain('collectionMode is not a v1 mode');
    });

    it('refuses a percentage rule with no base, an unknown base, or an out-of-range rate', () => {
      const noBase = {
        contractVersion: 1,
        collectionMode: 'deposit_online_balance_at_venue',
        deposit: { kind: 'percentage', basisPoints: 2_000, minimumToman: 0, maximumToman: null },
      } as unknown as BookingCollectionTermsV1;
      expect(validateBookingCollectionTermsV1(noBase)).toContain(
        'percentage deposit percentageBase must be service_subtotal or service_total',
      );

      const unknownBase = {
        ...percentageDeposit(2_000, 'service_total'),
        deposit: {
          kind: 'percentage',
          basisPoints: 2_000,
          percentageBase: 'service_after_tax',
          minimumToman: 0,
          maximumToman: null,
        },
      } as unknown as BookingCollectionTermsV1;
      expect(validateBookingCollectionTermsV1(unknownBase)).toContain(
        'percentage deposit percentageBase must be service_subtotal or service_total',
      );

      for (const rate of [0, -1, 10_001, 1.5]) {
        expect(validateBookingCollectionTermsV1(percentageDeposit(rate, 'service_total'))).toContain(
          'percentage deposit basisPoints must be an integer between 1 and 10000',
        );
      }
    });

    it('refuses a non-positive fixed amount and one above the representational bound', () => {
      expect(validateBookingCollectionTermsV1(fixedDeposit(0))[0]).toMatch(/positive integer/);
      expect(validateBookingCollectionTermsV1(fixedDeposit(MAX_COLLECTION_AMOUNT_TOMAN + 1))[0]).toMatch(
        /no greater than/,
      );
      expect(validateBookingCollectionTermsV1(fixedDeposit(MAX_COLLECTION_AMOUNT_TOMAN))).toEqual([]);
    });

    it('refuses a maximum below the minimum', () => {
      expect(validateBookingCollectionTermsV1(percentageDeposit(2_000, 'service_total', 100, 99))).toContain(
        'percentage deposit maximumToman must not be below minimumToman',
      );
    });

    it('returns EVERY problem rather than stopping at the first', () => {
      const doubly = {
        contractVersion: 2,
        collectionMode: 'deposit_online_balance_at_venue',
        deposit: { kind: 'percentage', basisPoints: 0, percentageBase: 'nope', minimumToman: -1, maximumToman: null },
      } as unknown as BookingCollectionTermsV1;
      const problems = validateBookingCollectionTermsV1(doubly);
      expect(problems.length).toBeGreaterThanOrEqual(4);
      expect(problems).toContain('contractVersion must be 1');
    });
  });

  // =========================================================================
  // §3. Exact integer arithmetic
  // =========================================================================

  describe('§3 arithmetic', () => {
    it('collects nothing at the venue and everything online, by mode', () => {
      expect(bookingCollectionAmountsV1(900, 1_000, payAtVenue)).toEqual({
        serviceTotalToman: 1_000,
        platformCollectibleToman: 0,
        venueBalanceToman: 1_000,
      });
      expect(bookingCollectionAmountsV1(900, 1_000, fullOnline)).toEqual({
        serviceTotalToman: 1_000,
        platformCollectibleToman: 1_000,
        venueBalanceToman: 0,
      });
    });

    it('applies the percentage to the ADMINISTRATOR-chosen base, not to a caller preference', () => {
      // The two bases differ here on purpose: 20% of 900 is 180, of 1000 is 200.
      expect(
        bookingCollectionAmountsV1(900, 1_000, percentageDeposit(2_000, 'service_subtotal')).platformCollectibleToman,
      ).toBe(180);
      expect(
        bookingCollectionAmountsV1(900, 1_000, percentageDeposit(2_000, 'service_total')).platformCollectibleToman,
      ).toBe(200);
    });

    it('floors rather than rounds, so rounding never collects more than the stated proportion', () => {
      // 33.33% of 100 = 33.33 -> 33, never 34.
      expect(
        bookingCollectionAmountsV1(100, 100, percentageDeposit(3_333, 'service_total')).platformCollectibleToman,
      ).toBe(33);
      // 1 basis point of 9,999 is 0.9999 -> 0.
      expect(
        bookingCollectionAmountsV1(9_999, 9_999, percentageDeposit(1, 'service_total')).platformCollectibleToman,
      ).toBe(0);
    });

    it('clamps up to the minimum, then down to the maximum, then down to the service total', () => {
      // 10% of 1,000 is 100; the minimum lifts it to 400.
      expect(
        bookingCollectionAmountsV1(1_000, 1_000, percentageDeposit(1_000, 'service_total', 400))
          .platformCollectibleToman,
      ).toBe(400);

      // 90% of 1,000 is 900; the maximum caps it at 250.
      expect(
        bookingCollectionAmountsV1(1_000, 1_000, percentageDeposit(9_000, 'service_total', 0, 250))
          .platformCollectibleToman,
      ).toBe(250);

      // The final clamp is LAST and wins: a minimum above the service total
      // must lose to the total, never collect above the disclosed price.
      expect(
        bookingCollectionAmountsV1(1_000, 1_000, percentageDeposit(1_000, 'service_total', 5_000))
          .platformCollectibleToman,
      ).toBe(1_000);

      // The same for a fixed deposit larger than the service.
      expect(bookingCollectionAmountsV1(1_000, 1_000, fixedDeposit(9_999)).platformCollectibleToman).toBe(1_000);
    });

    it('keeps the three amounts summing to the service total in every case', () => {
      const cases: BookingCollectionTermsV1[] = [
        payAtVenue,
        fullOnline,
        fixedDeposit(1),
        fixedDeposit(999_999),
        percentageDeposit(1, 'service_subtotal'),
        percentageDeposit(10_000, 'service_total'),
        percentageDeposit(4_321, 'service_subtotal', 7, 11),
      ];
      for (const terms of cases) {
        const amounts = bookingCollectionAmountsV1(7_331, 9_137, terms);
        expect(amounts.platformCollectibleToman + amounts.venueBalanceToman).toBe(amounts.serviceTotalToman);
        expect(amounts.platformCollectibleToman).toBeGreaterThanOrEqual(0);
        expect(amounts.venueBalanceToman).toBeGreaterThanOrEqual(0);
      }
    });

    it('is exact at the maximum representable amount, where Number multiplication would not be', () => {
      const max = MAX_COLLECTION_AMOUNT_TOMAN;
      // max * 9999 overflows Number.MAX_SAFE_INTEGER by many orders of
      // magnitude; BigInt is why this is the exact floor rather than a drifted
      // float. The expected value is computed the same exact way.
      const expected = Number((BigInt(max) * 9_999n) / 10_000n);
      expect(
        bookingCollectionAmountsV1(max, max, percentageDeposit(9_999, 'service_total')).platformCollectibleToman,
      ).toBe(expected);
      expect(bookingCollectionAmountsV1(max, max, percentageDeposit(10_000, 'service_total')).platformCollectibleToman).toBe(
        max,
      );
    });

    it('handles a zero-priced service without producing a negative balance', () => {
      const amounts = bookingCollectionAmountsV1(0, 0, percentageDeposit(5_000, 'service_total', 1_000));
      expect(amounts).toEqual({ serviceTotalToman: 0, platformCollectibleToman: 0, venueBalanceToman: 0 });
    });

    it('throws on an invalid amount or invalid terms rather than computing something', () => {
      expect(() => bookingCollectionAmountsV1(-1, 10, fullOnline)).toThrow(/serviceSubtotalToman/);
      expect(() => bookingCollectionAmountsV1(10, -1, fullOnline)).toThrow(/serviceTotalToman/);
      expect(() => bookingCollectionAmountsV1(10, MAX_COLLECTION_AMOUNT_TOMAN + 1, fullOnline)).toThrow(
        /serviceTotalToman/,
      );
      expect(() => bookingCollectionAmountsV1(10, 10, fixedDeposit(0))).toThrow(/Invalid collection terms/);
    });
  });

  // =========================================================================
  // §4. The snapshot
  // =========================================================================

  describe('§4 snapshot', () => {
    it('accepts a well-formed resolution snapshot', () => {
      expect(
        validateBookingCollectionPolicySnapshotV1({
          policyKey: 'standard-deposit',
          policyVersion: 3,
          resolvedAt: '2027-01-01T00:00:00.000Z',
          terms: fullOnline,
        }),
      ).toEqual([]);
    });

    it('refuses a malformed key, a non-positive version and an unparseable instant', () => {
      const problems = validateBookingCollectionPolicySnapshotV1({
        policyKey: '9-starts-with-a-digit',
        policyVersion: 0,
        resolvedAt: 'whenever',
        terms: fullOnline,
      });
      expect(problems).toHaveLength(3);
      expect(problems[0]).toMatch(/policyKey/);
      expect(problems[1]).toMatch(/policyVersion/);
      expect(problems[2]).toMatch(/resolvedAt/);
    });

    it('carries no identity of any kind', () => {
      const snapshot = {
        policyKey: 'k',
        policyVersion: 1,
        resolvedAt: '2027-01-01T00:00:00.000Z',
        terms: fullOnline,
      };
      // The snapshot is the resolution fact, not a commitment: no order,
      // seller, customer or administrator appears in it, and no acceptance.
      expect(Object.keys(snapshot).sort()).toEqual(['policyKey', 'policyVersion', 'resolvedAt', 'terms']);
      expect(Object.keys(snapshot)).not.toContain('acceptedAt');
      expect(Object.keys(snapshot)).not.toContain('policyAcceptedAt');
    });
  });

  // =========================================================================
  // §5. `resolvedAt` is not acceptance
  // =========================================================================

  describe('§5 resolution is not acceptance', () => {
    it('names the field resolvedAt and never acceptedAt', () => {
      // `BookingCommercialPolicySnapshotV1` (the #42-era type) calls its instant
      // `acceptedAt`, because it means acceptance. This one must not, and the
      // difference is the whole of `V33-DEC-029` Ruling 3.
      const source = readFileSync(join(__dirname, 'booking-collection-policy-contract.ts'), 'utf8');
      const declarations = source
        .split('\n')
        .filter((line) => /^\s+readonly \w+/.test(line))
        .join('\n');
      expect(declarations).toContain('resolvedAt');
      expect(declarations).not.toMatch(/readonly acceptedAt/);
      expect(declarations).not.toMatch(/readonly policyAcceptedAt/);
    });
  });

  // =========================================================================
  // §6. The pre-existing V1 contract is untouched
  // =========================================================================

  describe('§6 backward compatibility', () => {
    const wholePolicy = {
      contractVersion: COMMERCIAL_POLICY_CONTRACT_VERSION,
      collectionMode: 'deposit_online_balance_at_venue' as const,
      deposit: { kind: 'percentage' as const, basisPoints: 2_000, minimumToman: 0, maximumToman: null },
      cancellationCutoffMinutesBeforeStart: 1_440,
      lateCancellationRetainBasisPointsOfDeposit: 10_000,
      noShowRetainBasisPointsOfDeposit: 10_000,
      providerCancellationRefundBasisPointsOfDeposit: 10_000 as const,
      platformFaultRefundBasisPointsOfDeposit: 10_000 as const,
      rescheduleDepositAction: 'transfer_deposit' as const,
      disputeWindowMinutes: 4_320,
      settlementDelayMinutes: 2_880,
      customerPolicyCopyVersion: 'test-only-v1',
    };

    it('still validates and still computes exactly as before', () => {
      expect(validateBookingCommercialTermsV1(wholePolicy)).toEqual([]);
      expect(collectionBreakdownV1(1_000, wholePolicy)).toEqual({
        serviceTotalToman: 1_000,
        platformCollectibleToman: 200,
        venueBalanceToman: 800,
      });
    });

    it('still requires the #42/#43 fields this story does not own', () => {
      const { disputeWindowMinutes: _dispute, ...withoutDispute } = wholePolicy;
      void _dispute;
      expect(validateBookingCommercialTermsV1(withoutDispute as never)).toContain(
        'disputeWindowMinutes must be a non-negative safe integer',
      );

      const { settlementDelayMinutes: _settlement, ...withoutSettlement } = wholePolicy;
      void _settlement;
      expect(validateBookingCommercialTermsV1(withoutSettlement as never)).toContain(
        'settlementDelayMinutes must be a non-negative safe integer',
      );

      // `customerPolicyCopyVersion` is deliberately NOT asserted here. See the
      // case below: the V1 validator has a pre-existing hole on that field, and
      // asserting the behaviour it ought to have would have hidden it.
    });

    it('records a PRE-EXISTING hole in the V1 copy-version check, rather than hiding or fixing it', () => {
      // `COPY_VERSION_PATTERN.test(undefined)` stringifies its argument, and
      // the literal "undefined" matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. So
      // an ABSENT copy version validates clean today, while a malformed one is
      // caught correctly.
      //
      // This is a real defect in a field #42 owns, found by Story #83's suite
      // and reported rather than repaired here: `BookingCommercialTermsV1` is
      // not this story's type, and changing its validation is exactly the
      // silent widening `V33-DEC-029` Ruling 2 forbids. The new
      // collection-only validator does not share the hole -- it narrows with
      // `typeof` before testing the pattern, and §4 proves that.
      const { customerPolicyCopyVersion: _copy, ...withoutCopy } = wholePolicy;
      void _copy;
      expect(validateBookingCommercialTermsV1(withoutCopy as never)).toEqual([]);

      expect(validateBookingCommercialTermsV1({ ...wholePolicy, customerPolicyCopyVersion: '!!' })).toContain(
        'customerPolicyCopyVersion must be 1-64 safe version characters',
      );

      // The positive control for the claim that the NEW contract is immune.
      expect(
        validateBookingCollectionPolicySnapshotV1({
          policyKey: 'k',
          policyVersion: 1,
          terms: fullOnline,
        } as never),
      ).toContain('resolvedAt must be an ISO-compatible instant');
    });

    it('has a deposit shape the new contract deliberately does NOT satisfy', () => {
      // The old percentage rule has no base. Feeding it to the new validator
      // must fail, which is what makes the two types genuinely separate rather
      // than one silently widened.
      const asNewTerms = {
        contractVersion: 1,
        collectionMode: wholePolicy.collectionMode,
        deposit: wholePolicy.deposit,
      } as unknown as BookingCollectionTermsV1;
      expect(validateBookingCollectionTermsV1(asNewTerms)).toContain(
        'percentage deposit percentageBase must be service_subtotal or service_total',
      );
    });
  });
});
