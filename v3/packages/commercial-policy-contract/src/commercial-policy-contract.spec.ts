import * as contract from './commercial-policy-contract';
import {
  BOOKING_COLLECTION_MODES,
  COMMERCIAL_POLICY_CONTRACT_VERSION,
  RESCHEDULE_DEPOSIT_ACTIONS,
  BookingCommercialTermsV1,
  collectionBreakdownV1,
  validateBookingCommercialPolicySnapshotV1,
  validateBookingCommercialTermsV1,
} from './commercial-policy-contract';

const common = {
  contractVersion: 1,
  cancellationCutoffMinutesBeforeStart: 1_440,
  lateCancellationRetainBasisPointsOfDeposit: 10_000,
  noShowRetainBasisPointsOfDeposit: 10_000,
  providerCancellationRefundBasisPointsOfDeposit: 10_000,
  platformFaultRefundBasisPointsOfDeposit: 10_000,
  rescheduleDepositAction: 'transfer_deposit',
  disputeWindowMinutes: 2_880,
  settlementDelayMinutes: 2_880,
  customerPolicyCopyVersion: 'fa-IR.v1',
} as const;

const depositTerms = (): BookingCommercialTermsV1 => ({
  ...common,
  collectionMode: 'deposit_online_balance_at_venue',
  deposit: { kind: 'percentage', basisPoints: 2_000, minimumToman: 50_000, maximumToman: 500_000 },
});

describe('the v1 commercial policy vocabulary', () => {
  it('pins the version and the three owner-approved collection modes as literals', () => {
    expect(COMMERCIAL_POLICY_CONTRACT_VERSION).toBe(1);
    expect([...BOOKING_COLLECTION_MODES]).toEqual([
      'pay_at_venue',
      'deposit_online_balance_at_venue',
      'full_payment_online',
    ]);
    expect([...RESCHEDULE_DEPOSIT_ACTIONS]).toEqual(['transfer_deposit', 'refund_deposit']);
  });

  it('exports no identity, role, price plan, commission, gateway or production-enable surface', () => {
    for (const name of Object.keys(contract)) {
      expect(name).not.toMatch(/user|customer|seller|business|professional|role|plan|price|commission|gateway|provider|production/i);
    }
  });
});

describe('validateBookingCommercialTermsV1', () => {
  it('accepts one valid definition for every collection mode', () => {
    const definitions: BookingCommercialTermsV1[] = [
      { ...common, collectionMode: 'pay_at_venue', deposit: { kind: 'none' } },
      depositTerms(),
      { ...common, collectionMode: 'full_payment_online', deposit: { kind: 'none' } },
    ];
    for (const definition of definitions) expect(validateBookingCommercialTermsV1(definition)).toEqual([]);
  });

  it('requires deposit terms only for the deposit collection mode', () => {
    expect(
      validateBookingCommercialTermsV1({
        ...common,
        collectionMode: 'deposit_online_balance_at_venue',
        deposit: { kind: 'none' },
      }),
    ).toContain('deposit collection mode requires deposit terms');

    expect(
      validateBookingCommercialTermsV1({
        ...common,
        collectionMode: 'full_payment_online',
        deposit: { kind: 'fixed', amountToman: 100_000 },
      }),
    ).toContain('a deposit is only valid in deposit_online_balance_at_venue mode');
  });

  it('refuses unsafe amounts, percentages and ranges rather than normalising them', () => {
    const bad = {
      ...depositTerms(),
      deposit: { kind: 'percentage', basisPoints: 10_001, minimumToman: -1, maximumToman: -2 },
      cancellationCutoffMinutesBeforeStart: 1.5,
      lateCancellationRetainBasisPointsOfDeposit: -1,
      noShowRetainBasisPointsOfDeposit: 10_001,
      disputeWindowMinutes: Number.MAX_SAFE_INTEGER + 1,
      customerPolicyCopyVersion: '../unsafe copy',
    } as unknown as BookingCommercialTermsV1;
    const problems = validateBookingCommercialTermsV1(bad);
    expect(problems).toEqual(
      expect.arrayContaining([
        'percentage deposit basisPoints must be between 1 and 10000',
        'percentage deposit minimumToman must be a non-negative safe integer',
        'percentage deposit maximumToman must be null or a non-negative safe integer',
        'cancellationCutoffMinutesBeforeStart must be a non-negative safe integer',
        'lateCancellationRetainBasisPointsOfDeposit must be between 0 and 10000',
        'noShowRetainBasisPointsOfDeposit must be between 0 and 10000',
        'disputeWindowMinutes must be a non-negative safe integer',
        'customerPolicyCopyVersion must be 1-64 safe version characters',
      ]),
    );
  });

  it('makes provider and platform fault a full-refund invariant, not a seller choice', () => {
    const providerFault = { ...depositTerms(), providerCancellationRefundBasisPointsOfDeposit: 5_000 } as unknown as BookingCommercialTermsV1;
    const platformFault = { ...depositTerms(), platformFaultRefundBasisPointsOfDeposit: 0 } as unknown as BookingCommercialTermsV1;
    expect(validateBookingCommercialTermsV1(providerFault)).toContain(
      'provider cancellation must refund 10000 basis points of the deposit',
    );
    expect(validateBookingCommercialTermsV1(platformFault)).toContain(
      'platform fault must refund 10000 basis points of the deposit',
    );
  });
});

describe('collectionBreakdownV1', () => {
  it('keeps service total, platform collection and venue balance as exact separate facts', () => {
    expect(collectionBreakdownV1(1_000_000, depositTerms())).toEqual({
      serviceTotalToman: 1_000_000,
      platformCollectibleToman: 200_000,
      venueBalanceToman: 800_000,
    });
  });

  it('collects zero for pay-at-venue and all for full-online', () => {
    expect(
      collectionBreakdownV1(1_000_000, { ...common, collectionMode: 'pay_at_venue', deposit: { kind: 'none' } }),
    ).toEqual({ serviceTotalToman: 1_000_000, platformCollectibleToman: 0, venueBalanceToman: 1_000_000 });
    expect(
      collectionBreakdownV1(1_000_000, {
        ...common,
        collectionMode: 'full_payment_online',
        deposit: { kind: 'none' },
      }),
    ).toEqual({ serviceTotalToman: 1_000_000, platformCollectibleToman: 1_000_000, venueBalanceToman: 0 });
  });

  it('applies percentage min/max and never collects more than the service total', () => {
    expect(collectionBreakdownV1(100_000, depositTerms()).platformCollectibleToman).toBe(50_000);
    expect(collectionBreakdownV1(10_000_000, depositTerms()).platformCollectibleToman).toBe(500_000);
    const fixed: BookingCommercialTermsV1 = {
      ...common,
      collectionMode: 'deposit_online_balance_at_venue',
      deposit: { kind: 'fixed', amountToman: 5_000_000 },
    };
    expect(collectionBreakdownV1(1_000_000, fixed)).toEqual({
      serviceTotalToman: 1_000_000,
      platformCollectibleToman: 1_000_000,
      venueBalanceToman: 0,
    });
  });

  it('uses floor rounding and preserves exact-sum arithmetic', () => {
    const oneThird: BookingCommercialTermsV1 = {
      ...common,
      collectionMode: 'deposit_online_balance_at_venue',
      deposit: { kind: 'percentage', basisPoints: 3_333, minimumToman: 0, maximumToman: null },
    };
    const result = collectionBreakdownV1(101, oneThird);
    expect(result.platformCollectibleToman).toBe(33);
    expect(result.platformCollectibleToman + result.venueBalanceToman).toBe(result.serviceTotalToman);
  });

  it('keeps percentage arithmetic exact when the intermediate product exceeds Number.MAX_SAFE_INTEGER', () => {
    const almostAll: BookingCommercialTermsV1 = {
      ...common,
      collectionMode: 'deposit_online_balance_at_venue',
      deposit: { kind: 'percentage', basisPoints: 9_999, minimumToman: 0, maximumToman: null },
    };
    const serviceTotalToman = Number.MAX_SAFE_INTEGER;
    const expected = Number((BigInt(serviceTotalToman) * 9_999n) / 10_000n);
    const result = collectionBreakdownV1(serviceTotalToman, almostAll);
    expect(result.platformCollectibleToman).toBe(expected);
    expect(result.platformCollectibleToman + result.venueBalanceToman).toBe(serviceTotalToman);
  });

  it('refuses invalid totals and definitions instead of silently clamping bad input', () => {
    expect(() => collectionBreakdownV1(-1, depositTerms())).toThrow(/serviceTotalToman/);
    expect(() => collectionBreakdownV1(1.5, depositTerms())).toThrow(/serviceTotalToman/);
    expect(() =>
      collectionBreakdownV1(100, {
        ...common,
        collectionMode: 'deposit_online_balance_at_venue',
        deposit: { kind: 'fixed', amountToman: 0 },
      }),
    ).toThrow(/Invalid commercial terms/);
  });
});

describe('policy snapshots', () => {
  it('accepts a stable key, positive version and real instant', () => {
    expect(
      validateBookingCommercialPolicySnapshotV1({
        policyKey: 'salon_standard_deposit',
        policyVersion: 7,
        acceptedAt: '2026-09-01T12:00:00.000Z',
        terms: depositTerms(),
      }),
    ).toEqual([]);
  });

  it('refuses path-like keys, mutable version zero and fabricated time', () => {
    expect(
      validateBookingCommercialPolicySnapshotV1({
        policyKey: '../seller/override',
        policyVersion: 0,
        acceptedAt: 'not-a-date',
        terms: depositTerms(),
      }),
    ).toEqual(
      expect.arrayContaining([
        'policyKey must be a stable lowercase key',
        'policyVersion must be a positive safe integer',
        'acceptedAt must be an ISO-compatible instant',
      ]),
    );
  });
});
