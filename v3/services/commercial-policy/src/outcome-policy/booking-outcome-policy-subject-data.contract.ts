import { Injectable } from '@nestjs/common';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

/**
 * `#42a`'s subject-data contract — ADR-027, ADR-051 §10.
 *
 * ## All six tables are `retained`, and NONE is `no_subject_data`
 *
 * Every table carries administrator identity — `created_by_user_id`
 * throughout, `published_by_user_id` / `retired_by_user_id` on versions,
 * `recorded_by_user_id` / `retired_by_user_id` on the evidence record — and
 * the retention-option table is claimed on the same footing as
 * `commercial.price_tiers`: it is a child of a version an administrator
 * authored, not "reference data with no person in it". ADR-051 §10 fixes the
 * disposition and the reasons, and a direct pinning test in the suite refuses
 * any of them becoming `no_subject_data` even where ADR-027's column heuristic
 * would not fire.
 *
 * The reason is the one every catalogue table carries, and here it is
 * stronger still. A published outcome version decides what a customer can be
 * charged for a late cancellation or a no-show; a published copy is the text a
 * customer accepts; an evidence record is a person's attestation that Legal
 * evidence exists. An erasure able to blank WHO published, WHO wrote or WHO
 * attested would hand an operator a way to launder exactly the decisions the
 * whole family exists to make attributable. Retained, with the reason stated.
 *
 * ## Nothing is exported, to anyone
 *
 * A policy version, a copy and an evidence record are platform records, not
 * personal data about the administrator who authored them; and an export
 * route is not an authorization boundary. Returning the Legal-evidence
 * register or the unpublished drafts of a policy through a subject export
 * would disclose the platform's compliance posture and commercial
 * configuration to anyone requesting their own data. Customers and sellers
 * receive none of these rows; neither does the administrator.
 *
 * ## The counts are truthful
 *
 * Zero anonymized, zero deleted, six tables retained with their reasons.
 * Erasure genuinely does nothing here, the report says so, and the boot-time
 * coverage assertion proves the claim was reached rather than merely written.
 */
@Injectable()
export class BookingOutcomePolicySubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'commercial-outcome-policy';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'commercial.legal_evidence_records',
      disposition: 'retained',
      reason:
        'Carries recorded_by_user_id and retired_by_user_id. A compliance attestation that Legal evidence exists, referenced by published legal caps; erasing the attesting administrator would detach a cap from the person who vouched for its evidence (ADR-051 §5).',
    },
    {
      table: 'commercial.booking_outcome_policies',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id. The immutable record of which administrator opened an outcome-policy key; erasing the attribution would detach a published cancellation/no-show rule set from the person who created it.',
    },
    {
      table: 'commercial.booking_outcome_policy_versions',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id, published_by_user_id and retired_by_user_id. A published version fixes what a customer may be charged for a late cancellation or no-show and can never be edited; an attribution that could be erased would make it changeable in the one way that matters.',
    },
    {
      table: 'commercial.booking_outcome_policy_retention_options',
      disposition: 'retained',
      reason:
        'A child of an administrator-authored version, frozen with it once published. Claimed retained on the same footing as commercial.price_tiers rather than no_subject_data: the option set is part of the attributable commercial record, and ADR-051 §10 fixes the disposition.',
    },
    {
      table: 'commercial.customer_policy_copies',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id. The immutable record of which administrator opened a customer-copy key; the text under it is what customers accept.',
    },
    {
      table: 'commercial.customer_policy_copy_versions',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id, published_by_user_id and retired_by_user_id. A published copy version is the exact text a customer accepted (V33-DEC-039 R13) and can never be edited; the record of who published it must survive erasure.',
    },
  ];

  /** Nothing. See the class docblock. */
  async exportSubjectData(): Promise<SubjectExportSection[]> {
    return [];
  }

  async eraseSubjectData(): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: this.tables.map((claim) => ({
        table: claim.table,
        reason: 'immutable commercial and compliance record; administrator attribution must survive erasure',
      })),
    };
  }
}
