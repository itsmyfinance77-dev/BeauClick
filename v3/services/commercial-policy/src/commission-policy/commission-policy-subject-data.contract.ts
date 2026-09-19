import { Injectable } from '@nestjs/common';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

/**
 * `#43b-1`'s subject-data contract — ADR-027, ADR-052 §15.
 *
 * ## Both tables are `retained`, and neither is `no_subject_data`
 *
 * Both carry administrator identity — `created_by_user_id` on the key, and
 * `created_by_user_id` / `published_by_user_id` / `retired_by_user_id` on the
 * version — so ADR-027's column heuristic would refuse a `no_subject_data`
 * claim anyway. The reason they are retained is stronger than the heuristic:
 * a published commission version decides how much of a seller's money the
 * platform keeps, and it can never be edited. An attribution that could be
 * erased would make it changeable in the one way that matters, and would hand
 * an operator a way to launder exactly the decision the family exists to make
 * attributable.
 *
 * ## Nothing is exported, to anyone
 *
 * A commission rule is a platform record, not personal data about the
 * administrator who authored it, and an export route is not an authorization
 * boundary. Returning the commission register — including its unpublished
 * drafts — through a subject export would disclose the platform's commercial
 * configuration to anyone requesting their own data. Sellers and customers
 * receive none of these rows; neither does the administrator.
 *
 * ## The counts are truthful
 *
 * Zero anonymized, zero deleted, two tables retained with their reasons.
 * Erasure genuinely does nothing here, the report says so, and the boot-time
 * coverage assertion proves the claim was reached rather than merely written.
 */
@Injectable()
export class CommissionPolicySubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'commercial-commission-policy';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'commercial.commission_policies',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id. The immutable record of which administrator opened the commission key for a component; erasing the attribution would detach every published rate under it from the person who created it.',
    },
    {
      table: 'commercial.commission_policy_versions',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id, published_by_user_id and retired_by_user_id. A published version decides how much of a seller\'s money the platform keeps and can never be edited (ADR-052 §1); the record of who published it must survive erasure.',
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
        reason: 'immutable commercial record; administrator attribution must survive erasure',
      })),
    };
  }
}
