import { Injectable } from '@nestjs/common';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

/**
 * The assignment table's subject-data contract — ADR-027, ADR-048 §6,
 * V3.3 Story #104 (`#41d-2a`).
 *
 * ## Why this is its own contract file rather than a claim inside
 * `CommercialSubjectDataContract`
 *
 * ADR-048 §3 says the disposition is "added to
 * `commercial-subject-data.contract.ts`", and that instruction pre-dates the
 * `V33-DEC-031` split. Story #83 ships `story-83-boundary.spec.ts`, which lists
 * that file among #83's own and asserts the string
 * `seller_collection_policy_assignments` appears in none of them — a structural
 * guarantee that #83 contains no part of #104. Adding the claim there would
 * have broken that guarantee to satisfy a sentence written before the split
 * existed.
 *
 * So the claim lives here, in the module that owns the table, exactly as
 * `SubscriptionSubjectDataContract` lives beside the subscription tables rather
 * than inside the catalogue's. The ADR's requirement — an explicit disposition
 * with a stated reason, proved by the existing exact-set assertion — is met in
 * full; only the file is different, and this docblock is the record of why.
 *
 * ## `retained`, and the reason is an integrity guarantee rather than a formula
 *
 * ADR-027 admits `retained` for exactly two reasons, and this is the second:
 * *an integrity guarantee that erasure must not be able to defeat*.
 *
 * A row here records **which owner routed their own bookings' money through
 * which published policy, and when**. That is a governed commercial commitment,
 * and #115 will resolve orders against it. An erasure able to blank the
 * attribution would let an owner choose a policy, request deletion, and leave a
 * commercial history nobody is attached to — the same laundering the catalogue's
 * own claim names. Supersession is already permanent in the database; making the
 * actor erasable would reintroduce mutability through the one door left open.
 *
 * The columns and the claim agree, which is what makes the claim checkable:
 * `assigned_by_user_id` and `superseded_by_user_id` both carry the `_user_id`
 * suffix ADR-027's coverage check recognises, so a `no_subject_data` claim on
 * this table would be rejected at boot rather than merely being wrong.
 *
 * ## Nothing is exported, and that is not an oversight
 *
 * An assignment is a platform commercial record about a seller PARTY, not
 * personal data about the individual who happened to press the button. Two
 * consequences follow, and the second is the stronger:
 *
 *   1. an owner's subject export would gain nothing they cannot already read
 *      through the surface they hold the capability for;
 *   2. a dual owner, or a business owner and a professional who both touched a
 *      workspace, must never receive **the other party's** actor identity
 *      through their own export. An export route is not an authorization
 *      boundary, and the safe answer for a two-actor commercial record is to
 *      export neither side.
 *
 * The same call `CommercialSubjectDataContract` makes, for the same reason.
 */
@Injectable()
export class CollectionPolicyAssignmentSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'commercial-collection-policy-assignment';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'commercial.seller_collection_policy_assignments',
      disposition: 'retained',
      reason:
        'Carries assigned_by_user_id and superseded_by_user_id. The immutable record of which owner routed their own bookings money through which published collection policy, and when; orders will be resolved against it. Erasing the attribution would let an owner choose a policy, request deletion, and leave a governed commercial commitment with nobody attached to it.',
    },
  ];

  /**
   * Nothing. See the class docblock: this is a commercial record about a seller
   * party, and exporting it would hand one subject the other actor's identity.
   */
  async exportSubjectData(): Promise<SubjectExportSection[]> {
    return [];
  }

  /**
   * Nothing is anonymized and nothing is deleted, and the counts say so.
   *
   * That is a real answer rather than a stub: the assignment history is
   * database-immutable, there is no DELETE path at all, and the boot-time
   * coverage assertion against the live `pg_tables` catalogue is what proves
   * this claim was reached rather than merely written.
   */
  async eraseSubjectData(): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: this.tables.map((claim) => ({
        table: claim.table,
        reason: 'immutable commercial record; the owner who chose a collection policy must stay attributable',
      })),
    };
  }
}
