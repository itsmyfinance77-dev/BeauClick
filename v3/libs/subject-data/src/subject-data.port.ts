import { EntityManager } from 'typeorm';

/**
 * The per-module subject-data contract (`GAP-22`).
 *
 * WHY THIS IS A PORT EVERY MODULE IMPLEMENTS rather than one privacy service
 * that reads everybody's tables.
 *
 * V2 closed its export gap with a hardcoded call list inside the privacy
 * plugin. `PRIV-06` records what that cost: the list went stale the moment a
 * new plugin started storing user data, and nothing anywhere noticed. Fourteen
 * domains own user data in V3. A hand-maintained list would go stale in
 * exactly the same way, and the failure mode is silent -- an export that is
 * quietly incomplete looks identical to a complete one.
 *
 * So the direction is inverted. `privacy` orchestrates and knows nothing about
 * any domain's tables; each module answers for its OWN data, because only
 * booking knows what a booking means and only loyalty knows which of its rows
 * are the subject's. And `SubjectDataCoverage` (see coverage.ts) turns
 * "somebody remembered to register" into a boot-time assertion over the real
 * database catalogue: a table that exists and is claimed by nobody stops the
 * application from starting.
 *
 * `V3_DOMAIN_BOUNDARIES.md` §admin/privacy specifies exactly this shape --
 * "a thin orchestrator calling every module's own typed
 * `exportSubjectData(userId)`/`eraseSubjectData(userId)` contract,
 * self-registered". This is that contract, made typed and made enforceable.
 */

/** How one physical table relates to personal data. */
export type SubjectTableDisposition =
  /** Holds data about an identifiable subject. Exported, and erased or anonymized. */
  | 'subject_data'
  /**
   * Holds subject data that must SURVIVE erasure.
   *
   * Only two legitimate reasons exist in this platform and both are recorded
   * on the claim: a legal retention obligation (the financial ledger), or an
   * integrity guarantee that erasure must not be able to defeat (the
   * administrative audit log, which exists precisely so privileged actions
   * stay attributable).
   */
  | 'retained'
  /** Holds nothing about any identifiable person. Reference data, projections keyed by non-subject ids, bookkeeping. */
  | 'no_subject_data';

export interface SubjectTableClaim {
  /** `schema.table`, spelled exactly as PostgreSQL spells it. */
  readonly table: string;
  readonly disposition: SubjectTableDisposition;
  /**
   * Why.
   *
   * Required for `retained` and `no_subject_data` -- those are the two
   * dispositions that EXCUSE a table from erasure, so the reason is the whole
   * audit trail. `subject_data` needs none: it is the default obligation.
   */
  readonly reason?: string;
}

/** One named collection of the subject's rows, as it appears in the export document. */
export interface SubjectExportSection {
  /** Stable machine key, e.g. `bookings`. Becomes a property of the export document. */
  readonly key: string;
  /** One line a human can read, so the document explains itself without this codebase. */
  readonly description: string;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

/**
 * The placeholder identity a module writes where it must keep a row but must
 * not keep a person.
 *
 * Deterministic per subject rather than random, so two modules that both need
 * a placeholder produce the SAME one and the export/erasure record stays
 * internally consistent.
 */
export interface SubjectTombstone {
  readonly userId: string;
  /** Fits `identity.users.phone` (varchar(32)) and is unique per subject. */
  readonly phoneAlias: string;
  /** What a human sees where a name used to be. Identical for every erased subject, on purpose. */
  readonly displayAlias: string;
  readonly erasedAt: Date;
}

export interface SubjectErasureOutcome {
  readonly moduleKey: string;
  /** Rows whose identifying content was destroyed but which still exist. */
  readonly anonymized: number;
  /** Rows removed outright. */
  readonly deleted: number;
  /** Rows deliberately left untouched, with the reason, so the report is honest about what survives. */
  readonly retained: ReadonlyArray<{ readonly table: string; readonly reason: string }>;
}

export interface SubjectDataContract {
  /** Stable module key. Namespaces this module's sections in the export document. */
  readonly moduleKey: string;

  /**
   * Every physical table this module owns -- not only the ones holding subject
   * data.
   *
   * Total coverage is the point. A claim list restricted to "the tables with
   * personal data in them" would need somebody to decide, per table, whether
   * it qualifies -- and a table nobody classified would simply be absent,
   * indistinguishable from one that was considered and cleared. Requiring
   * every table to be claimed makes the decision mandatory and the omission
   * loud.
   */
  readonly tables: ReadonlyArray<SubjectTableClaim>;

  /**
   * Everything this module holds about the subject.
   *
   * Reads through the caller's `EntityManager` so the whole export is ONE
   * consistent snapshot: an export assembled from fourteen independent reads
   * can contain a booking that was cancelled halfway through and a timeline
   * that never learned about it.
   *
   * Must never include another person's data. A booking has two parties, and
   * only the subject's side of it belongs in the subject's export.
   */
  exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]>;

  /**
   * Destroys this module's link between the subject and their data.
   *
   * Runs inside the caller's transaction, alongside every other module's, so
   * a failure anywhere leaves the subject fully intact rather than half
   * erased -- there is no partial state a retry would have to reason about.
   *
   * The platform's erasure model is ANONYMIZATION WITH REFERENTIAL INTEGRITY
   * (`V3.1_PRODUCT_ROADMAP.md` §15-E, §9). Concretely that means:
   *
   *  * identity destroys the identifying material -- the phone number, the
   *    display name, the sessions;
   *  * every module destroys free text the SUBJECT authored, because prose is
   *    identifying in a way an id is not;
   *  * rows that are nothing but ids are LEFT ALONE, because once the identity
   *    they point at no longer exists they no longer describe a person -- and
   *    deleting them would corrupt a professional's business records and the
   *    ledger's referential integrity for no privacy gain.
   *
   * A module with nothing to do returns zeroes. That is a real answer, not a
   * stub, and the claim list is what proves it was reached.
   */
  eraseSubjectData(
    manager: EntityManager,
    userId: string,
    tombstone: SubjectTombstone,
  ): Promise<SubjectErasureOutcome>;
}

/** Multi-provider token. Every registered contract is collected into one array by the composition root. */
export const SUBJECT_DATA_CONTRACTS = Symbol('BEAUCLICK_SUBJECT_DATA_CONTRACTS');

/**
 * The deterministic tombstone for a subject.
 *
 * `phoneAlias` must fit `identity.users.phone` (varchar(32), UNIQUE) and must
 * never collide with a real Iranian phone number, so it is prefixed with
 * something no phone can start with. That leaves 26 hex characters of the
 * subject's own UUID -- 104 bits of an identifier already known to be unique,
 * and 30 characters in total with room to spare inside the column.
 */
export function tombstoneFor(userId: string, erasedAt: Date): SubjectTombstone {
  const compact = userId.replace(/-/g, '').slice(0, 26);
  return {
    userId,
    phoneAlias: `del:${compact}`,
    displayAlias: 'کاربر حذف‌شده',
    erasedAt,
  };
}
