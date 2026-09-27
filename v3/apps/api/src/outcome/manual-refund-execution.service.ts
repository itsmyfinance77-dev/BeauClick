import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AdminAuditService } from '@beauclick/audit';
import { BookingOutcomeDecisionService } from '@beauclick/commerce';
import { OutboxRelay } from '@beauclick/events';
import { ManualRefundExecutionEntity, PaymentService, RefundEntity } from '@beauclick/payment';

export const MANUAL_REFUND_AUDIT_ACTIONS = {
  claimed: 'payment.manual_refund_claimed',
  resolved: 'payment.manual_refund_resolved',
} as const;

export type ManualRefundOutcome = 'executed' | 'uncertain' | 'released';

/**
 * DEMO BRANCH ONLY — F-10 (demo/F10-DESIGN.md): the administrator's controlled
 * manual-refund execution, composed with commerce's decision in ONE transaction
 * and an admin audit row in the same transaction.
 *
 * The execution recorded here is SYNTHETIC in the demo: nothing moves money. The
 * claim is the only recorded way to execute and blocks the #212 supersession from
 * the moment it exists; it cannot detect a transfer made outside the system
 * without first taking it.
 */
@Injectable()
export class ManualRefundExecutionService {
  private readonly logger = new Logger('ManualRefundExecution');

  constructor(
    private readonly dataSource: DataSource,
    private readonly payments: PaymentService,
    private readonly decisions: BookingOutcomeDecisionService,
    private readonly audit: AdminAuditService,
    private readonly relay: OutboxRelay,
  ) {}

  list() {
    return this.payments.listManualRefunds();
  }

  async claim(actorUserId: string, refundId: string, note: string | null): Promise<ManualRefundExecutionEntity> {
    return this.dataSource.transaction(async (m) => {
      const execution = await this.payments.claimManualExecution(m, refundId, actorUserId, note);
      await this.audit.record(m, {
        actorUserId,
        action: MANUAL_REFUND_AUDIT_ACTIONS.claimed,
        targetType: 'payment_refund',
        targetId: refundId,
        reason: note,
        after: { executionId: execution.id, state: execution.state },
      });
      return execution;
    });
  }

  async resolve(
    actorUserId: string,
    executionId: string,
    outcome: ManualRefundOutcome,
    externalReference: string | null,
    note: string | null,
  ): Promise<{ execution: ManualRefundExecutionEntity; refund: RefundEntity }> {
    const result = await this.dataSource.transaction(async (m) => {
      const resolved = await this.payments.resolveManualExecution(m, executionId, actorUserId, outcome, externalReference, note);
      // Commerce's decision follows the money: executed by hand -> executed.
      if (outcome === 'executed') await this.decisions.markManuallyExecuted(m, resolved.refund.orderId, resolved.refund.requestKey);
      await this.audit.record(m, {
        actorUserId,
        action: MANUAL_REFUND_AUDIT_ACTIONS.resolved,
        targetType: 'payment_refund',
        targetId: resolved.refund.id,
        reason: note,
        after: { executionId, state: resolved.execution.state, refundStatus: resolved.refund.status, externalReference: resolved.execution.externalReference },
      });
      return resolved;
    });
    try {
      await this.relay.drain();
    } catch (err) {
      this.logger.warn(`Post-commit outbox drain failed; the periodic sweep will retry: ${String(err)}`);
    }
    return result;
  }
}
