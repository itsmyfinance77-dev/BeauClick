import { Injectable, Module } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { LegalCapState } from '@beauclick/commercial-policy-contract';

/**
 * The Legal cap's state at a booking outcome's decision instant — V3.3 Story
 * #160 (`#42c`), ADR-051 §5 ("the evaluator re-checks the referenced record's
 * status at decision time and treats a `retired` record as absent").
 *
 * ## Read-only, by id, on the caller's transaction
 *
 * An order's terms snapshot carries `legal_evidence_id` — the record the
 * published version's cap referenced when the order was created. This service
 * answers one question about that id, inside the deciding transaction, and
 * nothing else: no key, no list, no body, no reference and no summary ever
 * leave it. It is deliberately NOT `LegalEvidenceService` (#42a's administrator
 * plane, whose writers no decision path may reach).
 *
 * `FOR SHARE`, so an administrator retiring the record waits for an in-flight
 * decision rather than racing it: the decision sees the record either before
 * or after the retirement, never half of it.
 *
 * ## The three answers
 *
 *  * `applied` — the record exists, is `recorded`, and its subject is `retention_cap`;
 *  * `retired` — the record exists with subject `retention_cap` and was retired;
 *  * `absent`  — anything else: no id, no row, or a record about another subject.
 */
@Injectable()
export class LegalEvidenceStateService {
  async capStateFor(manager: EntityManager, legalEvidenceId: string | null): Promise<LegalCapState> {
    if (legalEvidenceId === null) return 'absent';

    const rows: Array<{ subject: string; status: string }> = await manager.query(
      `SELECT subject, status
         FROM commercial.legal_evidence_records
        WHERE id = $1
        FOR SHARE`,
      [legalEvidenceId],
    );
    const record = rows[0];
    if (!record || record.subject !== 'retention_cap') return 'absent';
    if (record.status === 'recorded') return 'applied';
    if (record.status === 'retired') return 'retired';
    return 'absent';
  }
}

/**
 * The read-only module the composition root binds Commerce's Legal-evidence
 * port to. It registers no entity, no controller and no writer.
 */
@Module({
  providers: [LegalEvidenceStateService],
  exports: [LegalEvidenceStateService],
})
export class BookingOutcomeEvaluationModule {}
