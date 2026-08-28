import { CatalogueTable, evaluateCoverage } from './coverage';
import { SubjectDataContract, SubjectTableClaim, tombstoneFor } from './subject-data.port';

/**
 * These cases exercise the property the whole design rests on: that FORGETTING
 * is what fails, not remembering. Every one of them is a mistake somebody
 * would plausibly make -- a new migration, a renamed table, a table classified
 * before it grew a `user_id` -- rather than a hypothetical.
 */

function contract(moduleKey: string, tables: SubjectTableClaim[]): SubjectDataContract {
  return {
    moduleKey,
    tables,
    exportSubjectData: async () => [],
    eraseSubjectData: async () => ({ moduleKey, anonymized: 0, deleted: 0, retained: [] }),
  };
}

function table(schema: string, name: string, columns: string[] = ['id']): CatalogueTable {
  return { schema, name, columns };
}

describe('subject-data coverage', () => {
  it('passes when every table is claimed exactly once', () => {
    const report = evaluateCoverage(
      [table('booking', 'bookings', ['id', 'customer_id']), table('provider', 'specialties', ['id', 'name'])],
      [
        contract('booking', [{ table: 'booking.bookings', disposition: 'subject_data' }]),
        contract('provider', [
          { table: 'provider.specialties', disposition: 'no_subject_data', reason: 'reference data' },
        ]),
      ],
    );

    expect(report.violations).toEqual([]);
    expect(report.tablesInDatabase).toBe(2);
  });

  it('fails when a new table exists that nobody claimed -- the whole point of the design', () => {
    const report = evaluateCoverage(
      [table('booking', 'bookings', ['id', 'customer_id']), table('referral', 'referrals', ['id', 'user_id'])],
      [contract('booking', [{ table: 'booking.bookings', disposition: 'subject_data' }])],
    );

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({ kind: 'unclaimed', table: 'referral.referrals' });
  });

  it('fails when two modules claim one table, because then neither erases it', () => {
    const report = evaluateCoverage(
      [table('loyalty', 'points_entries', ['id', 'user_id'])],
      [
        contract('loyalty', [{ table: 'loyalty.points_entries', disposition: 'subject_data' }]),
        contract('financial', [{ table: 'loyalty.points_entries', disposition: 'retained', reason: 'ledger-adjacent' }]),
      ],
    );

    expect(report.violations.map((v) => v.kind)).toEqual(['claimed_twice']);
  });

  it('fails on a claim for a table that no longer exists, so a rename cannot leave phantom coverage', () => {
    const report = evaluateCoverage(
      [table('journey', 'timeline_entries', ['id', 'user_id'])],
      [
        contract('journey', [
          { table: 'journey.timeline_entries', disposition: 'subject_data' },
          { table: 'journey.beauty_notes', disposition: 'subject_data' },
        ]),
      ],
    );

    expect(report.violations.map((v) => v.kind)).toEqual(['claimed_but_absent']);
    expect(report.violations[0].table).toBe('journey.beauty_notes');
  });

  it('rejects a no_subject_data claim on a table that carries a subject column', () => {
    // The realistic path to this: the table genuinely held no personal data
    // when it was classified, and later grew a `user_id`.
    const report = evaluateCoverage(
      [table('search', 'ranking_signals', ['professional_id', 'user_id'])],
      [
        contract('search', [
          { table: 'search.ranking_signals', disposition: 'no_subject_data', reason: 'keyed by professional' },
        ]),
      ],
    );

    expect(report.violations.map((v) => v.kind)).toEqual(['wrongly_declared_empty']);
    expect(report.violations[0].detail).toContain('user_id');
  });

  it('accepts a retained claim on a table that carries a subject column -- that is what retained MEANS', () => {
    const report = evaluateCoverage(
      [table('financial', 'ledger_entries', ['id', 'party_id', 'created_by'])],
      [
        contract('financial', [
          { table: 'financial.ledger_entries', disposition: 'retained', reason: 'append-only, legally retained' },
        ]),
      ],
    );

    expect(report.violations).toEqual([]);
  });

  it('counts dispositions so the boot line states what survives erasure', () => {
    const report = evaluateCoverage(
      [
        table('financial', 'ledger_entries', ['id']),
        table('booking', 'bookings', ['id']),
        table('provider', 'specialties', ['id']),
      ],
      [
        contract('financial', [{ table: 'financial.ledger_entries', disposition: 'retained', reason: 'legal' }]),
        contract('booking', [{ table: 'booking.bookings', disposition: 'subject_data' }]),
        contract('provider', [{ table: 'provider.specialties', disposition: 'no_subject_data', reason: 'reference' }]),
      ],
    );

    expect(report.byDisposition).toEqual({ subject_data: 1, retained: 1, no_subject_data: 1 });
  });
});

describe('tombstone', () => {
  it('fits identity.users.phone and never looks like a phone number', () => {
    const t = tombstoneFor('0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', new Date(0));
    expect(t.phoneAlias.length).toBeLessThanOrEqual(32);
    expect(t.phoneAlias.startsWith('del:')).toBe(true);
    expect(t.phoneAlias).not.toMatch(/^[+0-9]/);
  });

  it('is deterministic, so two modules independently deriving it agree', () => {
    const a = tombstoneFor('0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', new Date(0));
    const b = tombstoneFor('0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', new Date(1_000));
    expect(a.phoneAlias).toBe(b.phoneAlias);
    expect(a.displayAlias).toBe(b.displayAlias);
  });

  it('distinguishes two subjects', () => {
    // Differing inside the first 26 hex characters, which is where the alias
    // is derived from -- uuidv7 puts its timestamp and 54 bits of randomness
    // there, so two real ids always do.
    const a = tombstoneFor('0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', new Date(0));
    const b = tombstoneFor('0192a1b2-c3d4-7e5f-8a9b-0c1d3e3f4a5b', new Date(0));
    expect(a.phoneAlias).not.toBe(b.phoneAlias);
  });
});
