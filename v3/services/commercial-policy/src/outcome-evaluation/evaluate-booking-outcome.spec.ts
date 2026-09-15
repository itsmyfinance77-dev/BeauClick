import {
  BookingOutcomeEvaluationInputV1,
  BookingOutcomeRetentionRule,
  LegalCapState,
  MAX_OUTCOME_AMOUNT_TOMAN,
} from '@beauclick/commercial-policy-contract';

import { evaluateBookingOutcome, retentionAmount } from './evaluate-booking-outcome';

/**
 * The pure evaluator — V3.3 Story #160 (`#42c`), ADR-051 §6.
 *
 * Every rule of the ratified order is proved to short-circuit to zero on its
 * own, the one path that retains is proved to retain exactly
 * `min(policy, cap, collectedRemaining)`, and a seeded property run proves the
 * money identities over the full representational range — with floor division
 * checked against its DEFINITION rather than against a second copy of itself.
 */

const late = (rule: BookingOutcomeRetentionRule, cap: BookingOutcomeRetentionRule | null) => ({
  lateCancellationRetention: rule,
  legalCap: cap,
});

const base = (overrides: Partial<BookingOutcomeEvaluationInputV1> = {}): BookingOutcomeEvaluationInputV1 => ({
  cause: 'customer',
  bookingWasConfirmed: true,
  timely: false,
  collectedRemainingToman: 1_000_000n,
  terms: late({ kind: 'full_collected' }, { kind: 'full_collected' }),
  legalCapState: 'applied',
  ...overrides,
});

describe('evaluateBookingOutcome — the ratified order of rules', () => {
  it('positive control: a late customer cancellation of a confirmed booking under an applied cap retains', () => {
    const d = evaluateBookingOutcome(base());
    expect(d).toEqual({
      basis: 'cap_applied',
      policyAmountToman: 1_000_000n,
      legalCapToman: 1_000_000n,
      legalCapState: 'applied',
      retainedToman: 1_000_000n,
      refundToman: 0n,
    });
  });

  it.each<[string, Partial<BookingOutcomeEvaluationInputV1>, string]>([
    ['no terms row', { terms: null, timely: null }, 'legacy_unenrolled'],
    ['an invalid retention rule', { terms: late({ kind: 'percentage_of_collected', basisPoints: 10_000 }, null) }, 'invalid_terms'],
    ['terms without a timeliness fact', { timely: null }, 'invalid_terms'],
    ['a seller cause', { cause: 'seller' }, 'non_customer_cause'],
    ['a platform cause', { cause: 'platform' }, 'non_customer_cause'],
    ['a provider cause', { cause: 'provider' }, 'non_customer_cause'],
    ['a force-majeure cause', { cause: 'force_majeure' }, 'non_customer_cause'],
    ['a booking never confirmed', { bookingWasConfirmed: false }, 'not_confirmed'],
    ['a timely cancellation (the boundary included)', { timely: true }, 'timely'],
    ['an absent cap', { legalCapState: 'absent' }, 'cap_absent'],
    ['a retired cap', { legalCapState: 'retired' }, 'cap_retired'],
    ['"applied" with no cap rule on the terms', { terms: late({ kind: 'full_collected' }, null) }, 'cap_absent'],
  ])('%s retains zero and refunds everything remaining', (_label, overrides, basis) => {
    const d = evaluateBookingOutcome(base(overrides));
    expect(d.basis).toBe(basis);
    expect(d.retainedToman).toBe(0n);
    expect(d.refundToman).toBe(1_000_000n);
    // The cap amount is present exactly when its state is applied.
    expect(d.legalCapToman !== null).toBe(d.legalCapState === 'applied');
  });

  it('an absent cap is never read as "capped at the policy amount"', () => {
    const d = evaluateBookingOutcome(base({ legalCapState: 'absent', terms: late({ kind: 'fixed_toman', amountToman: 400_000 }, null) }));
    expect(d.policyAmountToman).toBe(400_000n);
    expect(d.retainedToman).toBe(0n);
  });

  it('retains the smallest of policy, cap and collected — each operand can be the binding one', () => {
    const collected = 1_000_000n;
    const policyBinds = evaluateBookingOutcome(
      base({ terms: late({ kind: 'fixed_toman', amountToman: 100_000 }, { kind: 'fixed_toman', amountToman: 300_000 }) }),
    );
    expect(policyBinds.retainedToman).toBe(100_000n);
    const capBinds = evaluateBookingOutcome(
      base({ terms: late({ kind: 'fixed_toman', amountToman: 500_000 }, { kind: 'percentage_of_collected', basisPoints: 2_500 }) }),
    );
    expect(capBinds.retainedToman).toBe(250_000n);
    const collectedBinds = evaluateBookingOutcome(
      base({
        collectedRemainingToman: 60_000n,
        terms: late({ kind: 'fixed_toman', amountToman: 500_000 }, { kind: 'fixed_toman', amountToman: 90_000 }),
      }),
    );
    expect(collectedBinds.retainedToman).toBe(60_000n);
    expect(collectedBinds.refundToman).toBe(0n);
    expect(policyBinds.refundToman + policyBinds.retainedToman).toBe(collected);
  });

  it('a `none` late rule retains zero even under an applied cap', () => {
    const d = evaluateBookingOutcome(base({ terms: late({ kind: 'none' }, { kind: 'full_collected' }) }));
    expect(d.basis).toBe('cap_applied');
    expect(d.retainedToman).toBe(0n);
  });

  it('refuses a negative collected amount rather than deciding on it', () => {
    expect(() => evaluateBookingOutcome(base({ collectedRemainingToman: -1n }))).toThrow(/must not be negative/);
  });
});

describe('retentionAmount — the closed rule shapes', () => {
  it('floors percentages and refuses shapes the contract does not admit', () => {
    expect(retentionAmount({ kind: 'percentage_of_collected', basisPoints: 3_333 }, 10_001n)).toBe(3_333n); // 3333.3333 floors
    expect(retentionAmount({ kind: 'percentage_of_collected', basisPoints: 1 }, 9_999n)).toBe(0n);
    expect(retentionAmount({ kind: 'percentage_of_collected', basisPoints: 0 }, 1n)).toBeNull();
    expect(retentionAmount({ kind: 'percentage_of_collected', basisPoints: 1.5 }, 1n)).toBeNull();
    expect(retentionAmount({ kind: 'fixed_toman', amountToman: 0 }, 1n)).toBeNull();
    expect(retentionAmount({ kind: 'fixed_toman', amountToman: MAX_OUTCOME_AMOUNT_TOMAN + 1 }, 1n)).toBeNull();
    expect(retentionAmount({ kind: 'mystery' } as unknown as BookingOutcomeRetentionRule, 1n)).toBeNull();
  });

  it('is exact past Number’s integer range: 10¹³ × 9 999 bp', () => {
    const collected = 10_000_000_000_000n;
    expect(retentionAmount({ kind: 'percentage_of_collected', basisPoints: 9_999 }, collected)).toBe(9_999_000_000_000n);
    expect(Number.isSafeInteger(Number(collected) * 9_999)).toBe(false);
  });

  it('floors exactly where double rounding would cross the boundary', () => {
    // 9 999 999 990 001 × 9 999 = 99 989 999 900 019 999 ≡ 9 999 (mod 10 000): the
    // true quotient is …990 001.9999, which floors to …990 001. As a double the
    // product rounds UP to the next multiple of 16 (…020 000), whose quotient
    // floors to …990 002. The 10¹³ vector above happens to be exactly
    // representable and could not tell the two apart — a mutation probe proved
    // that — so this one can.
    const collected = 9_999_999_990_001n;
    expect(collected * 9_999n).toBe(99_989_999_900_019_999n);
    expect(retentionAmount({ kind: 'percentage_of_collected', basisPoints: 9_999 }, collected)).toBe(9_998_999_990_001n);
    // Non-vacuity: Number arithmetic really does get this vector wrong.
    expect(BigInt(Math.floor((Number(collected) * 9_999) / 10_000))).toBe(9_998_999_990_002n);
  });
});

describe('evaluateBookingOutcome — seeded property run over the representational range', () => {
  // A tiny deterministic generator, so a failure is reproducible from the seed.
  // xorshift32: an LCG's low bits cycle with a tiny period, which the
  // non-vacuity assertion below caught on the first draft of this run.
  function generator(seed: number) {
    let s = seed >>> 0 || 1;
    const next = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s;
    };
    const bigintBelow = (limit: bigint) => (BigInt(next()) * 4_294_967_296n + BigInt(next())) % limit;
    const intBetween = (lo: number, hi: number) => lo + (next() % (hi - lo + 1));
    const rule = (): BookingOutcomeRetentionRule => {
      switch (next() % 4) {
        case 0:
          return { kind: 'none' };
        case 1:
          return { kind: 'full_collected' };
        case 2:
          return { kind: 'percentage_of_collected', basisPoints: intBetween(1, 9_999) };
        default:
          return { kind: 'fixed_toman', amountToman: Number(bigintBelow(BigInt(MAX_OUTCOME_AMOUNT_TOMAN)) + 1n) };
      }
    };
    return { next, bigintBelow, rule };
  }

  const floorHolds = (rule: BookingOutcomeRetentionRule, collected: bigint, amount: bigint) => {
    if (rule.kind !== 'percentage_of_collected') return true;
    const product = collected * BigInt(rule.basisPoints);
    return amount * 10_000n <= product && product < (amount + 1n) * 10_000n;
  };

  it('keeps retained + refund = collected, never retains more than any operand, and floors by definition', () => {
    const g = generator(0x42c);
    const states: LegalCapState[] = ['applied', 'absent', 'retired'];
    let retainedCases = 0;

    for (let i = 0; i < 5_000; i += 1) {
      const collected = g.bigintBelow(BigInt(MAX_OUTCOME_AMOUNT_TOMAN) + 1n);
      const lateRule = g.rule();
      const capRule = g.next() % 5 === 0 ? null : g.rule();
      const input: BookingOutcomeEvaluationInputV1 = {
        cause: g.next() % 4 === 0 ? 'seller' : 'customer',
        bookingWasConfirmed: g.next() % 5 !== 0,
        timely: g.next() % 3 === 0,
        collectedRemainingToman: collected,
        terms: late(lateRule, capRule),
        legalCapState: states[g.next() % 3],
      };
      const d = evaluateBookingOutcome(input);

      expect(d.retainedToman + d.refundToman).toBe(collected);
      expect(d.retainedToman >= 0n && d.refundToman >= 0n).toBe(true);
      expect(d.retainedToman <= collected).toBe(true);
      expect(d.retainedToman <= d.policyAmountToman).toBe(true);
      expect(floorHolds(lateRule, collected, d.policyAmountToman)).toBe(true);

      if (d.retainedToman > 0n) {
        retainedCases += 1;
        expect(d.basis).toBe('cap_applied');
        expect(input.cause).toBe('customer');
        expect(input.bookingWasConfirmed).toBe(true);
        expect(input.timely).toBe(false);
        expect(d.legalCapState).toBe('applied');
        expect(d.legalCapToman).not.toBeNull();
        expect(d.retainedToman <= (d.legalCapToman as bigint)).toBe(true);
        expect(floorHolds(capRule as BookingOutcomeRetentionRule, collected, d.legalCapToman as bigint)).toBe(true);
      } else if (d.basis === 'cap_applied') {
        // Zero only because one operand is zero.
        const operands = [d.policyAmountToman, d.legalCapToman as bigint, collected];
        expect(operands.some((operand) => operand === 0n)).toBe(true);
      }
    }

    // Non-vacuity: the run exercised the retaining path many times.
    expect(retainedCases).toBeGreaterThan(200);
  });
});
