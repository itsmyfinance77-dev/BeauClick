import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import { SELLER_RISK_CLASSES, SellerRiskClass } from '@beauclick/commercial-policy-contract';

import {
  CommercialLifecycleConflictException,
  CommercialReasonRequiredException,
  CommercialTermsInvalidException,
} from '../catalogue/commercial-catalogue.exceptions';
import { SETTLEMENT_AUDIT_ACTIONS, SETTLEMENT_AUDIT_TARGETS, translatingSettlement } from './settlement-schedule.constants';
import { SellerRiskClassAssignmentEntity } from './settlement-schedule.entities';

export interface SellerParty {
  readonly partyType: 'professional' | 'business';
  readonly partyId: string;
}

/**
 * The seller risk class — V3.3 Story #175 (`#43d`), ADR-052 §1,
 * `V33-DEC-040` R4.
 *
 * ## It never infers
 *
 * R4 says a risk class is "never inferred", and this service is the only way
 * one comes into existence. There is no scoring, no backfill, no default and
 * no trigger: an administrator classifies a seller deliberately, with a
 * stated reason, or the seller has no class at all — which `#43e`'s resolver
 * reads as `unresolved` rather than as `standard`.
 *
 * ## Superseded, never edited
 *
 * A re-classification writes a NEW row and stamps the old one superseded in
 * the same transaction. The history is therefore complete: "this seller was
 * elevated between these two instants, by this administrator, for this
 * reason" is answerable forever, which is what makes a settlement cadence
 * explainable after the fact.
 *
 * The partial unique index — not this service — is what makes two concurrent
 * first classifications impossible; the CAS below turns the race into a
 * readable conflict rather than a constraint name.
 */
@Injectable()
export class SellerRiskClassService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
  ) {}

  /** The party's CURRENT class, or null when nobody has classified them. */
  async currentFor(manager: EntityManager, party: SellerParty): Promise<SellerRiskClassAssignmentEntity | null> {
    return manager.getRepository(SellerRiskClassAssignmentEntity).findOne({
      where: { sellerPartyType: party.partyType, sellerPartyId: party.partyId, supersededAt: null as never },
    });
  }

  async historyFor(party: SellerParty): Promise<SellerRiskClassAssignmentEntity[]> {
    return this.dataSource.getRepository(SellerRiskClassAssignmentEntity).find({
      where: { sellerPartyType: party.partyType, sellerPartyId: party.partyId },
      order: { assignedAt: 'DESC' },
    });
  }

  /**
   * Classifies a seller, superseding any current class in the same
   * transaction. Returns the new row.
   */
  async assign(
    actorUserId: string,
    party: SellerParty,
    riskClass: SellerRiskClass,
    reason: string,
  ): Promise<SellerRiskClassAssignmentEntity> {
    const statedReason = this.requireReason(reason);
    this.requireRiskClass(riskClass);
    this.requirePartyType(party.partyType);

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SellerRiskClassAssignmentEntity);

      /*
       * The current row is locked FOR UPDATE before anything is written: a
       * concurrent re-classification is an UPDATE of exactly this row, so it
       * waits here rather than racing the partial unique index and losing
       * with a constraint name.
       */
      const current = await manager
        .getRepository(SellerRiskClassAssignmentEntity)
        .createQueryBuilder('assignment')
        .setLock('pessimistic_write')
        .where(
          'assignment.seller_party_type = :partyType AND assignment.seller_party_id = :partyId AND assignment.superseded_at IS NULL',
          { partyType: party.partyType, partyId: party.partyId },
        )
        .getOne();

      const id = uuidv7();

      if (current) {
        // Supersede FIRST: the partial unique index permits exactly one
        // current row, so the new one cannot be inserted while the old one
        // still counts as current.
        const superseded = await translatingSettlement(
          () =>
            manager
              .createQueryBuilder()
              .update(SellerRiskClassAssignmentEntity)
              .set({
                supersededAt: () => 'now()',
                supersededByUserId: actorUserId,
                supersededByAssignmentId: id,
              } as never)
              .where('id = :id AND superseded_at IS NULL', { id: current.id })
              .execute(),
          'seller risk class',
        );
        if (superseded.affected !== 1) {
          throw new CommercialLifecycleConflictException(
            'the seller was re-classified by somebody else while this classification was being written',
          );
        }
      }

      await translatingSettlement(
        () =>
          repo.insert({
            id,
            sellerPartyType: party.partyType,
            sellerPartyId: party.partyId,
            riskClass,
            reason: statedReason,
            assignedByUserId: actorUserId,
            assignedByLabel: null,
          }),
        'seller risk class',
      );

      await this.audit.record(manager, {
        actorUserId,
        action: SETTLEMENT_AUDIT_ACTIONS.riskClassAssigned,
        targetType: SETTLEMENT_AUDIT_TARGETS.riskClass,
        targetId: `${party.partyType}:${party.partyId}`,
        reason: statedReason,
        before: current ? { riskClass: current.riskClass } : null,
        after: { riskClass },
      });

      const created = await repo.findOne({ where: { id } });
      if (!created) throw new CommercialLifecycleConflictException('the classification did not land');
      return created;
    });
  }

  private requireRiskClass(riskClass: SellerRiskClass): void {
    if (!SELLER_RISK_CLASSES.includes(riskClass)) {
      throw new CommercialTermsInvalidException([`riskClass must be one of ${SELLER_RISK_CLASSES.join(', ')}`]);
    }
  }

  private requirePartyType(partyType: string): void {
    if (partyType !== 'professional' && partyType !== 'business') {
      throw new CommercialTermsInvalidException(['partyType must be professional or business']);
    }
  }

  private requireReason(reason: string): string {
    const trimmed = (reason ?? '').trim();
    if (trimmed.length === 0) throw new CommercialReasonRequiredException();
    if (trimmed.length > 500) {
      throw new CommercialTermsInvalidException(['reason must not exceed 500 characters']);
    }
    return trimmed;
  }
}
