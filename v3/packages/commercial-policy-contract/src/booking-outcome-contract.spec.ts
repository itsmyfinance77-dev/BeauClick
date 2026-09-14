import {
  AllowedOutcomeMembersV1,
  BookingOutcomeSelectionV1,
  BookingOutcomeSnapshotV1,
  acceptanceFor,
  acceptanceMatches,
  bookingOutcomeRetentionColumns,
  bookingOutcomeRetentionRuleFromColumns,
  sameOutcomeSelection,
  selectionOutsideAllowed,
  validateBookingOutcomeAcceptanceV1,
  validateBookingOutcomeSelectionV1,
  validateBookingOutcomeSnapshotV1,
  validateBookingOutcomeTermsV1,
} from './booking-outcome-contract';
import { BookingOutcomeRetentionRule } from './booking-outcome-policy-contract';

/**
 * The #159 (`#42b`) contract, fast — ADR-051 §2–§4. Suite fixtures only; none
 * of these numbers is a product value.
 */

const SELECTION: BookingOutcomeSelectionV1 = {
  cutoffHours: 12,
  lateCancellationRetention: { kind: 'percentage_of_collected', basisPoints: 2_500 },
  noShowGraceMinutes: 10,
  noShowRetention: { kind: 'fixed_toman', amountToman: 40_000 },
};

const SNAPSHOT: BookingOutcomeSnapshotV1 = {
  policyKey: 'suitePolicy',
  policyVersion: 2,
  copyKey: 'suiteCopy',
  copyVersion: 3,
  resolvedAt: '2026-09-14T10:00:00.123456Z',
  legalEvidenceId: null,
  terms: {
    contractVersion: 1,
    ...SELECTION,
    rescheduleFreeCountBeforeCutoff: 1,
    disputeWindowHours: 36,
    bodilyHarmWindowHours: 96,
    appealWindowHours: 48,
    caseFileRetentionDays: null,
    legalCap: null,
  },
};

const ALLOWED: AllowedOutcomeMembersV1 = {
  cutoffHours: [6, 12, 48],
  lateCancellationRetention: [{ kind: 'none' }, { kind: 'percentage_of_collected', basisPoints: 2_500 }],
  noShowGraceMinutes: [5, 10],
  noShowRetention: [{ kind: 'fixed_toman', amountToman: 40_000 }],
};

describe('BookingOutcomeSelectionV1', () => {
  it('accepts a well-formed selection', () => {
    expect(validateBookingOutcomeSelectionV1(SELECTION)).toEqual([]);
  });

  it.each([
    ['a missing member', { ...SELECTION, cutoffHours: undefined }],
    ['a fractional hour', { ...SELECTION, cutoffHours: 1.5 }],
    ['an hour beyond the bound', { ...SELECTION, cutoffHours: 8_761 }],
    ['a negative grace', { ...SELECTION, noShowGraceMinutes: -1 }],
    ['a kind carrying the wrong field', { ...SELECTION, noShowRetention: { kind: 'none', amountToman: 1 } }],
    ['a percentage of zero', { ...SELECTION, lateCancellationRetention: { kind: 'percentage_of_collected', basisPoints: 0 } }],
    ['an unknown field', { ...SELECTION, sellerPartyId: 'x' }],
    ['not an object', null],
  ])('refuses %s', (_label, candidate) => {
    expect(validateBookingOutcomeSelectionV1(candidate).length).toBeGreaterThan(0);
  });

  it('names every member outside the allowed sets, and never a value', () => {
    expect(selectionOutsideAllowed(SELECTION, ALLOWED)).toEqual([]);
    const outside = selectionOutsideAllowed(
      { cutoffHours: 7, lateCancellationRetention: { kind: 'full_collected' }, noShowGraceMinutes: 30, noShowRetention: { kind: 'none' } },
      ALLOWED,
    );
    expect(outside).toEqual(['cutoffHours', 'noShowGraceMinutes', 'lateCancellationRetention', 'noShowRetention']);
  });

  it('compares selections by meaning', () => {
    expect(sameOutcomeSelection(SELECTION, { ...SELECTION })).toBe(true);
    expect(sameOutcomeSelection(SELECTION, { ...SELECTION, noShowRetention: { kind: 'fixed_toman', amountToman: 40_001 } })).toBe(false);
  });
});

describe('BookingOutcomeTermsV1 and BookingOutcomeSnapshotV1', () => {
  it('accepts a well-formed snapshot', () => {
    expect(validateBookingOutcomeSnapshotV1(SNAPSHOT)).toEqual([]);
  });

  it('refuses a bodily-harm window shorter than the dispute window, and a cap of kind none', () => {
    expect(validateBookingOutcomeTermsV1({ ...SNAPSHOT.terms, bodilyHarmWindowHours: 35 }).length).toBeGreaterThan(0);
    expect(validateBookingOutcomeTermsV1({ ...SNAPSHOT.terms, legalCap: { kind: 'none' } }).length).toBeGreaterThan(0);
  });

  it('pairs a cap with its evidence reference in both directions', () => {
    const capped = { ...SNAPSHOT, terms: { ...SNAPSHOT.terms, legalCap: { kind: 'full_collected' as const } } };
    expect(validateBookingOutcomeSnapshotV1(capped)).toContain('a legal cap requires its evidence reference');
    expect(validateBookingOutcomeSnapshotV1({ ...capped, legalEvidenceId: '0190a9a0-0000-7000-8000-000000000001' })).toEqual([]);
    expect(validateBookingOutcomeSnapshotV1({ ...SNAPSHOT, legalEvidenceId: '0190a9a0-0000-7000-8000-000000000001' })).toContain(
      'an evidence reference exists only together with a legal cap',
    );
  });

  it('refuses a local-time instant and an unknown field', () => {
    expect(validateBookingOutcomeSnapshotV1({ ...SNAPSHOT, resolvedAt: '2026-09-14 10:00:00' }).length).toBeGreaterThan(0);
    expect(validateBookingOutcomeSnapshotV1({ ...SNAPSHOT, copyBody: 'x' }).length).toBeGreaterThan(0);
  });
});

describe('BookingOutcomeAcceptanceV1', () => {
  it('is exactly the four identifiers of the snapshot', () => {
    const acceptance = acceptanceFor(SNAPSHOT);
    expect(acceptance).toEqual({ policyKey: 'suitePolicy', policyVersion: 2, copyKey: 'suiteCopy', copyVersion: 3 });
    expect(validateBookingOutcomeAcceptanceV1(acceptance)).toEqual([]);
    expect(acceptanceMatches(acceptance, SNAPSHOT)).toBe(true);
  });

  it.each([
    ['a stale policy version', { policyVersion: 1 }],
    ['another copy version', { copyVersion: 4 }],
    ['another key', { policyKey: 'otherPolicy' }],
    ['another copy', { copyKey: 'otherCopy' }],
  ])('does not match %s', (_label, change) => {
    expect(acceptanceMatches({ ...acceptanceFor(SNAPSHOT), ...change }, SNAPSHOT)).toBe(false);
  });

  it('refuses an instant, text or any other field on the acceptance', () => {
    expect(validateBookingOutcomeAcceptanceV1({ ...acceptanceFor(SNAPSHOT), acceptedAt: 'now' }).length).toBeGreaterThan(0);
    expect(validateBookingOutcomeAcceptanceV1({ ...acceptanceFor(SNAPSHOT), policyVersion: 0 }).length).toBeGreaterThan(0);
    expect(validateBookingOutcomeAcceptanceV1({ ...acceptanceFor(SNAPSHOT), copyKey: '1bad' }).length).toBeGreaterThan(0);
  });
});

describe('retention columns', () => {
  it.each<BookingOutcomeRetentionRule>([
    { kind: 'none' },
    { kind: 'full_collected' },
    { kind: 'percentage_of_collected', basisPoints: 1 },
    { kind: 'fixed_toman', amountToman: 10_000_000_000_000 },
  ])('round-trips %j', (rule) => {
    const columns = bookingOutcomeRetentionColumns(rule);
    expect(bookingOutcomeRetentionRuleFromColumns(columns.kind, columns.basisPoints, columns.amountToman)).toEqual(rule);
  });

  it('reads a bigint string and fails an unknown kind closed', () => {
    expect(bookingOutcomeRetentionRuleFromColumns('fixed_toman', null, '40000')).toEqual({ kind: 'fixed_toman', amountToman: 40_000 });
    expect(validateBookingOutcomeSelectionV1({ ...SELECTION, noShowRetention: bookingOutcomeRetentionRuleFromColumns('mystery', null, null) }).length).toBeGreaterThan(0);
  });
});
