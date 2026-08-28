import { SubjectDataContract, SubjectTableClaim } from './subject-data.port';

/**
 * The structural guarantee behind the export contract.
 *
 * `V3.1_PRODUCT_ROADMAP.md` §15-E states the requirement precisely: every
 * data-owning module is covered "**asserted structurally** rather than by a
 * hand-maintained list -- a new module that owns user data and does not
 * register must fail the suite. That property is the whole point of the
 * design."
 *
 * THE UNIVERSE IS THE DATABASE CATALOGUE, not a list of entity classes and not
 * a list of modules. `pg_tables` is read at boot and every table it reports
 * must be claimed by exactly one contract. That choice matters in three ways:
 *
 *  1. A migration that creates a table nobody claimed fails startup. Entity
 *     metadata would not catch that -- V2's `professional_specialties`-shaped
 *     join tables and every future projection exist as real tables with no
 *     entity class of their own.
 *  2. `pg_tables` is not privilege-filtered, unlike `information_schema`. The
 *     application role holds no privileges at all on `financial.*` (ADR-017),
 *     so an `information_schema` universe would have silently excluded the
 *     ledger -- the single most legally sensitive table in the platform --
 *     from the check meant to guarantee nothing is missed.
 *  3. Two contracts claiming one table is also an error. A table with two
 *     owners has none: each module would assume the other erased it.
 *
 * A `no_subject_data` claim is not a free pass. A table declared to hold
 * nothing personal that nonetheless carries a subject-shaped column is
 * rejected by name, because that is precisely how a table gets waved through:
 * not by malice, but by somebody classifying it before the column existed.
 */

/**
 * Column names that hold `identity.users.id`, or personal contact data
 * directly.
 *
 * This list is a NAMING CONVENTION, not an inventory -- it is the one part of
 * this check a new table could evade, and it evades it only by inventing a
 * column name no other table in the platform uses. Weighed against the
 * alternative (a per-table inventory, which is the stale list this design
 * exists to eliminate) that is the correct place to put the residual risk, and
 * it is stated here rather than left to be discovered.
 */
export const SUBJECT_COLUMN_NAMES: ReadonlySet<string> = new Set([
  'user_id',
  'customer_id',
  'owner_id',
  'actor_id',
  'subject_id',
  'cancelled_by_actor_id',
  'phone',
  'email',
]);

/**
 * Two suffixes carry a subject id everywhere in this schema, without exception:
 *
 *   * `*_by`      -- `submitted_by`, `decided_by`, `moderated_by`, `granted_by`,
 *                    `invited_by`, `reported_by`, `taken_down_by`, `created_by`,
 *                    `cancelled_by`. Every one of them is an actor.
 *   * `*_user_id` -- `owner_user_id`, `subject_user_id`, `session_user_id`,
 *                    `actor_user_id`, `existing_user_id`.
 *
 * Matching on the suffix rather than enumerating the names is what makes the
 * check survive the next table: `decided_by` on a column that does not exist
 * yet is already covered.
 */
const SUBJECT_COLUMN_SUFFIXES = ['_by', '_user_id'];

export function isSubjectColumn(column: string): boolean {
  return SUBJECT_COLUMN_NAMES.has(column) || SUBJECT_COLUMN_SUFFIXES.some((suffix) => column.endsWith(suffix));
}

/** One physical table as the database reports it. */
export interface CatalogueTable {
  readonly schema: string;
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
}

export interface CoverageViolation {
  readonly kind: 'unclaimed' | 'claimed_twice' | 'claimed_but_absent' | 'wrongly_declared_empty';
  readonly table: string;
  readonly detail: string;
}

export interface CoverageReport {
  readonly tablesInDatabase: number;
  readonly tablesClaimed: number;
  readonly violations: ReadonlyArray<CoverageViolation>;
  readonly byDisposition: Readonly<Record<string, number>>;
}

export function qualifiedName(table: CatalogueTable): string {
  return `${table.schema}.${table.name}`;
}

/**
 * Compares what the database contains against what the modules claim.
 *
 * Pure, and deliberately so: the boot assertion and the test that proves the
 * assertion can actually fail both call this with data they control, and
 * neither has to stand up a database to exercise the logic.
 */
export function evaluateCoverage(
  catalogue: ReadonlyArray<CatalogueTable>,
  contracts: ReadonlyArray<SubjectDataContract>,
): CoverageReport {
  const violations: CoverageViolation[] = [];
  const byDisposition: Record<string, number> = { subject_data: 0, retained: 0, no_subject_data: 0 };

  // Which module claims which table, and how many claimed it.
  const claims = new Map<string, Array<{ moduleKey: string; claim: SubjectTableClaim }>>();
  for (const contract of contracts) {
    for (const claim of contract.tables) {
      const existing = claims.get(claim.table) ?? [];
      existing.push({ moduleKey: contract.moduleKey, claim });
      claims.set(claim.table, existing);
      byDisposition[claim.disposition] = (byDisposition[claim.disposition] ?? 0) + 1;
    }
  }

  const catalogueByName = new Map(catalogue.map((t) => [qualifiedName(t), t]));

  for (const table of catalogue) {
    const name = qualifiedName(table);
    const claimants = claims.get(name);

    if (!claimants || claimants.length === 0) {
      violations.push({
        kind: 'unclaimed',
        table: name,
        detail:
          'No module claims this table. Every table must be claimed by exactly one SubjectDataContract, ' +
          'as subject_data, retained, or no_subject_data -- a table nobody classified is a table nobody exports or erases.',
      });
      continue;
    }

    if (claimants.length > 1) {
      violations.push({
        kind: 'claimed_twice',
        table: name,
        detail: `Claimed by ${claimants.map((c) => c.moduleKey).join(' and ')}. A table with two owners has none: each module assumes the other erased it.`,
      });
    }

    for (const { moduleKey, claim } of claimants) {
      if (claim.disposition !== 'no_subject_data') continue;
      const offending = table.columns.filter(isSubjectColumn);
      if (offending.length > 0) {
        violations.push({
          kind: 'wrongly_declared_empty',
          table: name,
          detail:
            `${moduleKey} declares this table holds no subject data, but it carries ${offending.join(', ')}. ` +
            'Re-classify it as subject_data or retained.',
        });
      }
    }
  }

  for (const [name, claimants] of claims) {
    if (catalogueByName.has(name)) continue;
    violations.push({
      kind: 'claimed_but_absent',
      table: name,
      detail:
        `${claimants.map((c) => c.moduleKey).join(', ')} claims a table that does not exist. ` +
        'A stale claim silently covers nothing, which is worse than no claim at all -- it reads as coverage.',
    });
  }

  return {
    tablesInDatabase: catalogue.length,
    tablesClaimed: claims.size,
    violations,
    byDisposition,
  };
}

export class SubjectDataCoverageError extends Error {
  readonly violations: ReadonlyArray<CoverageViolation>;

  constructor(report: CoverageReport) {
    super(
      'Subject-data coverage is incomplete, so a privacy export or erasure would silently miss data.\n' +
        report.violations.map((v) => `  [${v.kind}] ${v.table}: ${v.detail}`).join('\n'),
    );
    this.violations = report.violations;
  }
}
