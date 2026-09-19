import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
  SubjectTombstone,
} from '@beauclick/subject-data';

import { SellerRiskClassAssignmentEntity } from './settlement-schedule.entities';

/**
 * `#43d`'s subject-data contract — ADR-027, ADR-052 §15, and the privacy
 * review #175's own acceptance criteria demanded at preflight.
 *
 * ## Three tables, all `retained`
 *
 * The two schedule tables carry administrator attribution and are the
 * published basis for when a seller's money moves; the assignment table
 * carries both the administrator who classified a seller and the seller
 * party itself. An erasure able to remove any of them would leave a
 * settlement cadence nobody could explain.
 *
 * ## The class is exported. The reason is NOT.
 *
 * This is the decision recorded on #175's preflight, and it is the whole
 * reason this contract has an export at all:
 *
 *  * **The class IS a fact about the seller** that materially changes when
 *    their money moves. Withholding it would mean a seller could not see why
 *    their payouts follow the cadence they do, which is exactly what ADR-027's
 *    export exists to prevent.
 *  * **The free-text reason is not exported.** An `elevated` classification
 *    in practice encodes risk and fraud-detection signal — a chargeback
 *    pattern, a dispute rate, a manual review note. Returning it through a
 *    self-service export would turn the export route into a disclosure of the
 *    platform's detection posture to the one party with an interest in
 *    evading it. The administrator surface returns it; the seller's own-data
 *    export does not.
 *  * **Neither is erasable.** Both are the recorded basis of a commercial
 *    decision about money.
 *
 * The export is keyed by the OWNING user of the party, so a bookkeeper or a
 * staff member reaches nothing here: this is the seller's own classification,
 * not their workplace's.
 */
@Injectable()
export class SettlementScheduleSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'commercial-settlement-schedule';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'commercial.settlement_schedule_policies',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id. The immutable record of which administrator opened a settlement schedule key for a plan and risk class; erasing the attribution would detach every published cadence under it from the person who created it.',
    },
    {
      table: 'commercial.settlement_schedule_policy_versions',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id, published_by_user_id and retired_by_user_id. A published version decides how often a seller is paid and how much is held back, and can never be edited; the record of who published it must survive erasure.',
    },
    {
      table: 'commercial.seller_risk_class_assignments',
      disposition: 'retained',
      reason:
        "Carries assigned_by_user_id, superseded_by_user_id and the seller party. The recorded basis for a seller's settlement cadence and reserve; an erasure able to remove it would leave a cadence nobody could explain. The class is exported to the owning seller; the free-text reason is not (ADR-027, #175 preflight).",
    },
  ];

  /**
   * The seller's own classifications — class and instants only.
   *
   * Joined through the party tables so the subject is the OWNER of the
   * professional profile or the business, which is the only person whose
   * money the cadence governs.
   */
  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const rows: Array<{ risk_class: string; assigned_at: Date; superseded_at: Date | null }> = await manager.query(
      `SELECT a.risk_class, a.assigned_at, a.superseded_at
         FROM commercial.seller_risk_class_assignments a
        WHERE (a.seller_party_type = 'professional'
                 AND a.seller_party_id IN (SELECT id FROM provider.professionals WHERE owner_id = $1))
           OR (a.seller_party_type = 'business'
                 AND a.seller_party_id IN (SELECT id FROM business.businesses WHERE owner_id = $1))
        ORDER BY a.assigned_at DESC`,
      [userId],
    );

    if (rows.length === 0) return [];

    return [
      {
        key: 'seller_risk_classes',
        description:
          'The risk classes recorded for the seller accounts you own, and when each began and ended. The class decides how often your settlements are proposed and whether a reserve is held.',
        rows: rows.map((row) => ({
          riskClass: row.risk_class,
          assignedAt: row.assigned_at.toISOString(),
          supersededAt: row.superseded_at?.toISOString() ?? null,
          // No `reason`, and no administrator identity. Deliberate; see the
          // class docblock and #175's preflight.
        })),
      },
    ];
  }

  async eraseSubjectData(
    _manager: EntityManager,
    _userId: string,
    _tombstone: SubjectTombstone,
  ): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: this.tables.map((claim) => ({
        table: claim.table,
        reason: 'the published basis for when a seller is paid, and the recorded classification behind it',
      })),
    };
  }
}
