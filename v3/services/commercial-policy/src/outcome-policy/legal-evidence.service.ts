import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import {
  CATALOGUE_KEY_PATTERN,
  LEGAL_EVIDENCE_SUBJECT_FOR_CAP,
  LegalEvidenceRecordInputV1,
  validateLegalEvidenceRecordInputV1,
} from '@beauclick/commercial-policy-contract';

import {
  CommercialLifecycleConflictException,
  CommercialNotFoundException,
  CommercialReasonRequiredException,
  CommercialTermsInvalidException,
} from '../catalogue/commercial-catalogue.exceptions';
import { LegalEvidenceRecordEntity } from './booking-outcome-policy.entities';
import { OUTCOME_POLICY_AUDIT_ACTIONS, OUTCOME_POLICY_AUDIT_TARGETS, translating } from './booking-outcome-policy.constants';

/**
 * Legal-evidence records — V3.3 Story #42 (`#42a`), ADR-051 §5.
 *
 * ## What a record is, and is not
 *
 * A record is a privileged administrator's ATTESTATION that a piece of Legal
 * evidence exists somewhere else, under a stable key: its subject, where it
 * is (a reference), and a short summary. It stores no document, no name, no
 * advice and no file, and this service has no upload, no fetch and no way to
 * judge what the referenced document says. Whether the reference is what the
 * summary claims is a fact a person attests to by recording it.
 *
 * ## What it gates
 *
 * A published booking-outcome policy version with a `legalCap` must reference
 * a record that is `recorded` and of subject `retention_cap`. The gate is the
 * trigger `commercial.require_valid_legal_evidence_for_cap`, not this class;
 * `qualifiesForCap` below is the readable pre-check the outcome-policy service
 * runs inside its own transaction so an administrator gets one typed refusal
 * instead of a constraint name.
 *
 * ## Audit precedes the row, inside one transaction
 *
 * `recorded_audit_id` is NOT NULL, so the audit row is written first and the
 * record then references it; both commit together or neither does, and a
 * failed audit leaves no record (ADR-051 §5, proved by the real-PostgreSQL
 * suite's rollback probe).
 */
@Injectable()
export class LegalEvidenceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
  ) {}

  async list(): Promise<LegalEvidenceRecordEntity[]> {
    return this.dataSource.getRepository(LegalEvidenceRecordEntity).find({ order: { evidenceKey: 'ASC' } });
  }

  async get(evidenceKey: string): Promise<LegalEvidenceRecordEntity> {
    return this.requireByKey(this.dataSource.manager, evidenceKey);
  }

  async record(
    actorUserId: string,
    evidenceKey: string,
    input: LegalEvidenceRecordInputV1,
    reason: string,
  ): Promise<LegalEvidenceRecordEntity> {
    const statedReason = this.requireReason(reason);
    if (!CATALOGUE_KEY_PATTERN.test(evidenceKey)) {
      throw new CommercialTermsInvalidException(['the key must be 1-64 characters of [A-Za-z0-9_-] starting with a letter']);
    }
    const problems = validateLegalEvidenceRecordInputV1(input);
    if (problems.length > 0) throw new CommercialTermsInvalidException(problems);

    return this.dataSource.transaction(async (manager) => {
      const id = uuidv7();
      const auditId = await this.audit.record(manager, {
        actorUserId,
        action: OUTCOME_POLICY_AUDIT_ACTIONS.legalEvidenceRecorded,
        targetType: OUTCOME_POLICY_AUDIT_TARGETS.legalEvidence,
        targetId: evidenceKey,
        reason: statedReason,
        // The reference and summary stay on the row; the audit snapshot carries
        // the closed vocabulary members only.
        after: { evidenceKey, subject: input.subject, referenceKind: input.referenceKind },
      });

      const repo = manager.getRepository(LegalEvidenceRecordEntity);
      await translating(
        () =>
          repo.insert({
            id,
            evidenceKey,
            subject: input.subject,
            status: 'recorded',
            referenceKind: input.referenceKind,
            reference: input.reference.trim(),
            summary: input.summary.trim(),
            recordedByUserId: actorUserId,
            recordedAuditId: auditId,
            retiredAt: null,
            retiredByUserId: null,
            retiredAuditId: null,
          }),
        'legal evidence record',
      );

      return this.requireByKey(manager, evidenceKey);
    });
  }

  /**
   * `recorded -> retired`. The row is locked FOR UPDATE first, the transition
   * is compare-and-swapped on `status = 'recorded'`, and the audit row is
   * written in the same transaction; a retired record rewrites NO policy
   * version (published rows are immutable), and the runtime consequence of a
   * retirement is `#42c`'s, not this story's.
   */
  async retire(actorUserId: string, evidenceKey: string, reason: string): Promise<LegalEvidenceRecordEntity> {
    const statedReason = this.requireReason(reason);

    return this.dataSource.transaction(async (manager) => {
      const existing = await manager
        .getRepository(LegalEvidenceRecordEntity)
        .createQueryBuilder('e')
        .setLock('pessimistic_write')
        .where('e.evidence_key = :evidenceKey', { evidenceKey })
        .getOne();
      if (!existing) throw new CommercialNotFoundException();
      if (existing.status !== 'recorded') {
        throw new CommercialLifecycleConflictException('the evidence record is already retired');
      }

      const auditId = await this.audit.record(manager, {
        actorUserId,
        action: OUTCOME_POLICY_AUDIT_ACTIONS.legalEvidenceRetired,
        targetType: OUTCOME_POLICY_AUDIT_TARGETS.legalEvidence,
        targetId: evidenceKey,
        reason: statedReason,
        before: { status: 'recorded', subject: existing.subject },
        after: { status: 'retired' },
      });

      const updated = await translating(
        () =>
          manager
            .createQueryBuilder()
            .update(LegalEvidenceRecordEntity)
            .set({
              status: 'retired',
              retiredAt: () => 'now()',
              retiredByUserId: actorUserId,
              retiredAuditId: auditId,
            } as never)
            .where('id = :id AND status = :status', { id: existing.id, status: 'recorded' })
            .execute(),
        'legal evidence record',
      );
      if (updated.affected !== 1) {
        throw new CommercialLifecycleConflictException('the evidence record stopped being recorded before the retirement landed');
      }

      return this.requireByKey(manager, evidenceKey);
    });
  }

  /**
   * The readable half of the cap gate: does this key name a record that a
   * `legalCap` may be published against RIGHT NOW? Returns the row so the
   * caller can bind its id, or null for every non-qualifying cause alike.
   * Runs on the caller's manager, inside the caller's transaction.
   */
  async qualifiesForCap(manager: EntityManager, evidenceKey: string): Promise<LegalEvidenceRecordEntity | null> {
    const row = await manager
      .getRepository(LegalEvidenceRecordEntity)
      .createQueryBuilder('e')
      .setLock('pessimistic_read')
      .where('e.evidence_key = :evidenceKey', { evidenceKey })
      .getOne();
    if (!row) return null;
    if (row.status !== 'recorded') return null;
    if (row.subject !== LEGAL_EVIDENCE_SUBJECT_FOR_CAP) return null;
    return row;
  }

  private requireReason(reason: string): string {
    if (typeof reason !== 'string') throw new CommercialReasonRequiredException();
    const trimmed = reason.trim();
    if (trimmed.length < 3 || trimmed.length > 500) throw new CommercialReasonRequiredException();
    return trimmed;
  }

  private async requireByKey(manager: EntityManager, evidenceKey: string): Promise<LegalEvidenceRecordEntity> {
    const row = await manager.getRepository(LegalEvidenceRecordEntity).findOne({ where: { evidenceKey } });
    if (!row) throw new CommercialNotFoundException();
    return row;
  }
}
