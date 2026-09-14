import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { retentionRuleFromColumns } from './outcome-policy-rows';

/**
 * The outcome-selection table's subject-data contract — ADR-027, ADR-051 §10,
 * V3.3 Story #159 (`#42b`).
 *
 * ## `retained`, for #104's integrity reason
 *
 * A row records which owner committed their own bookings to which outcome
 * rules, and when; every governed order is resolved against it. Blanking the
 * attribution would let an owner choose terms, request deletion, and leave a
 * commercial commitment with nobody attached. `assigned_by_user_id` and
 * `superseded_by_user_id` carry the `_user_id` suffix ADR-027's coverage check
 * recognises, so a `no_subject_data` claim would be refused at boot.
 *
 * ## Exported: the selections the subject AUTHORED (the #159 preflight, C9)
 *
 * ADR-051 §10 requires the owning seller's export to carry their selections,
 * where #104's twin exports nothing. The rows are selected by
 * `assigned_by_user_id` — what this person chose — and the export carries the
 * key, the four members and the two instants. It never carries
 * `superseded_by_user_id`: a successor chosen by another owner after a
 * transfer is that person's act, and an export route is not an authorization
 * boundary for handing one subject another's identity.
 */
@Injectable()
export class OutcomePolicyAssignmentSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'commercial-outcome-policy-assignment';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'commercial.seller_outcome_policy_assignments',
      disposition: 'retained',
      reason:
        'Carries assigned_by_user_id and superseded_by_user_id. The immutable record of which owner committed their own bookings to which published cancellation and no-show rules, and when; governed orders are resolved against it. Erasing the attribution would leave a governed commercial commitment with nobody attached to it.',
    },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const rows: Array<{
      policy_key: string;
      seller_party_type: string;
      cutoff_hours: number;
      late_retention_kind: string;
      late_retention_basis_points: number | null;
      late_retention_amount_toman: string | null;
      grace_minutes: number;
      no_show_retention_kind: string;
      no_show_retention_basis_points: number | null;
      no_show_retention_amount_toman: string | null;
      assigned_at: Date;
      superseded_at: Date | null;
    }> = await manager.query(
      `SELECT policy_key, seller_party_type, cutoff_hours,
              late_retention_kind, late_retention_basis_points, late_retention_amount_toman,
              grace_minutes,
              no_show_retention_kind, no_show_retention_basis_points, no_show_retention_amount_toman,
              assigned_at, superseded_at
         FROM commercial.seller_outcome_policy_assignments
        WHERE assigned_by_user_id = $1
        ORDER BY assigned_at, id`,
      [userId],
    );

    return [
      {
        key: 'outcome_policy_selections',
        description: 'انتخاب‌های شما از سیاست لغو و عدم حضور',
        rows: rows.map((row) => ({
          policyKey: row.policy_key,
          sellerPartyType: row.seller_party_type,
          cutoffHours: Number(row.cutoff_hours),
          lateCancellationRetention: retentionRuleFromColumns(
            row.late_retention_kind,
            row.late_retention_basis_points,
            row.late_retention_amount_toman,
          ),
          noShowGraceMinutes: Number(row.grace_minutes),
          noShowRetention: retentionRuleFromColumns(
            row.no_show_retention_kind,
            row.no_show_retention_basis_points,
            row.no_show_retention_amount_toman,
          ),
          assignedAt: row.assigned_at,
          supersededAt: row.superseded_at,
        })),
      },
    ];
  }

  /** Nothing is anonymized or deleted: the history is database-immutable and has no DELETE path. */
  async eraseSubjectData(): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: this.tables.map((claim) => ({
        table: claim.table,
        reason: 'immutable commercial record; the owner who chose outcome terms must stay attributable',
      })),
    };
  }
}
